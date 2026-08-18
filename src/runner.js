const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const db = require('./db');
const { decrypt } = require('./crypto');

const maxPagesPerViewport = Math.max(1, Number(process.env.MAX_PAGES_PER_RUN || 20));
const pageTimeout = Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 20000));
const visualThresholdPct = Math.max(0, Number(process.env.VISUAL_DIFF_THRESHOLD_PCT || 0.25));
const artifactRoot = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');
const axePath = require.resolve('axe-core/axe.min.js');

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
  'small-mobile': { width: 360, height: 800 }
};

const dangerousPath = /(logout|log-out|signout|sign-out|delete|remove|destroy|terminate|drop|purge|unsubscribe)/i;

function cleanUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    url.hash = '';
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function severityForStatus(status) {
  if (status >= 500) return 'critical';
  if (status >= 400) return 'high';
  return 'medium';
}

function accessibilitySeverity(impact) {
  if (impact === 'critical' || impact === 'serious') return 'high';
  if (impact === 'moderate') return 'medium';
  return 'low';
}

function parseViewports(project) {
  try {
    const parsed = JSON.parse(project.viewport_profiles || '[]');
    const valid = Array.isArray(parsed) ? parsed.filter((name) => VIEWPORTS[name]) : [];
    return valid.length ? valid : ['desktop'];
  } catch {
    return ['desktop'];
  }
}

function parseExtraLoginFields(project) {
  if (!project.extra_login_fields_enc) return [];
  try {
    const parsed = JSON.parse(decrypt(project.extra_login_fields_enc));
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function cssQuoted(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function visibleLocator(locator) {
  try {
    return await locator.count() && await locator.first().isVisible({ timeout: 500 }) ? locator.first() : null;
  } catch {
    return null;
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = await visibleLocator(page.locator(selector));
    if (locator) return locator;
  }
  return null;
}

async function locateCustomField(page, field) {
  if (field.selector) {
    const locator = await visibleLocator(page.locator(field.selector));
    if (locator) return locator;
  }

  if (field.name) {
    try {
      const byLabel = await visibleLocator(page.getByLabel(field.name, { exact: false }));
      if (byLabel) return byLabel;
    } catch {}

    const name = cssQuoted(field.name);
    const selectors = [
      `[name="${name}"]`,
      `#${String(field.name).replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`,
      `input[placeholder*="${name}" i]`,
      `select[aria-label*="${name}" i]`,
      `input[aria-label*="${name}" i]`
    ];
    const auto = await firstVisible(page, selectors);
    if (auto) return auto;
  }

  return null;
}

async function fillCustomField(page, field, addLooseIssue, viewportName) {
  const locator = await locateCustomField(page, field);
  if (!locator) {
    addLooseIssue('high', 'authentication', `Could not find extra login field: ${field.name || field.selector}`, `Viewport: ${viewportName}`);
    return;
  }

  try {
    const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
    if (field.type === 'select' || tagName === 'select') {
      await locator.selectOption({ label: field.value }).catch(() => locator.selectOption(field.value));
    } else {
      await locator.fill(String(field.value || ''));
    }
  } catch (error) {
    addLooseIssue('high', 'authentication', `Could not fill extra login field: ${field.name || field.selector}`, `${viewportName}: ${error.message}`);
  }
}

async function attemptLogin(page, project, addLooseIssue, viewportName) {
  if (!project.login_url) return;
  if (!project.username || !project.password_enc) {
    addLooseIssue('medium', 'authentication', 'Login URL is configured but username/password are incomplete', `Viewport: ${viewportName}`);
    return;
  }

  const loginUrl = cleanUrl(project.login_url, project.base_url);
  if (!loginUrl) {
    addLooseIssue('high', 'authentication', 'Invalid login URL', project.login_url || '');
    return;
  }

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: pageTimeout });

    for (const field of parseExtraLoginFields(project)) {
      await fillCustomField(page, field, addLooseIssue, viewportName);
    }

    const userInput = await firstVisible(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[name*="login" i]',
      'input[type="text"]'
    ]);
    const passInput = await firstVisible(page, ['input[type="password"]']);

    if (!userInput || !passInput) {
      addLooseIssue('high', 'authentication', 'QADeck could not identify the username/password fields', `${loginUrl} · ${viewportName}`);
      return;
    }

    await userInput.fill(project.username);
    await passInput.fill(decrypt(project.password_enc));

    const submit = await firstVisible(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")'
    ]);

    if (!submit) {
      addLooseIssue('high', 'authentication', 'QADeck could not identify the login submit button', `${loginUrl} · ${viewportName}`);
      return;
    }

    await submit.click();
    await page.waitForLoadState('domcontentloaded', { timeout: pageTimeout }).catch(() => {});
    await page.waitForTimeout(700);

    const passwordStillVisible = await page.locator('input[type="password"]:visible').count();
    if (passwordStillVisible) {
      addLooseIssue('high', 'authentication', 'Login may have failed; password field is still visible', `${page.url()} · ${viewportName}`);
    }
  } catch (error) {
    addLooseIssue('high', 'authentication', 'Login flow failed', `${viewportName}: ${error.message}`);
  }
}

function updateProgress(runId, pagesScanned, totalIssues, cleanPages, currentUrl = null) {
  db.prepare(`
    UPDATE test_runs
    SET pages_scanned=?, issues_count=?, clean_pages=?, current_url=?, heartbeat_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='running'
  `).run(pagesScanned, totalIssues, cleanPages, currentUrl, runId);
}

function baselineInfo(projectId, viewportName, url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);
  const relative = path.join('baselines', String(projectId), viewportName, `${hash}.png`);
  return {
    absolute: path.join(artifactRoot, relative),
    web: `/artifacts/${relative.split(path.sep).join('/')}`
  };
}

function compareVisual(currentPath, baselinePath, diffPath) {
  const current = PNG.sync.read(fs.readFileSync(currentPath));
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return { changedPct: 100, dimensionChanged: true, diffWritten: false };
  }

  const diff = new PNG({ width: current.width, height: current.height });
  const changedPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    current.width,
    current.height,
    { threshold: 0.1, includeAA: false }
  );
  const changedPct = (changedPixels / (current.width * current.height)) * 100;
  if (changedPixels > 0) fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return { changedPct, dimensionChanged: false, diffWritten: changedPixels > 0 };
}

async function runAccessibility(page, addPageIssue) {
  try {
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => window.axe.run(document, {
      resultTypes: ['violations'],
      rules: { region: { enabled: false } }
    }));

    for (const violation of result.violations.slice(0, 30)) {
      const targets = violation.nodes.slice(0, 4).flatMap((node) => node.target || []).join(', ');
      addPageIssue(
        accessibilitySeverity(violation.impact),
        'accessibility',
        violation.help || violation.id,
        `${violation.description || ''}${targets ? `\nElements: ${targets}` : ''}`
      );
    }
    return result.violations.length;
  } catch (error) {
    addPageIssue('low', 'accessibility', 'Accessibility scan could not complete', error.message);
    return 0;
  }
}

async function runProject(runId, project, options = {}) {
  const workerId = options.workerId || null;
  const runDir = path.join(artifactRoot, String(runId));
  const videoDir = path.join(runDir, 'videos');
  fs.mkdirSync(runDir, { recursive: true });
  if (project.enable_video) fs.mkdirSync(videoDir, { recursive: true });

  db.prepare(`
    UPDATE test_runs
    SET status='running', started_at=COALESCE(started_at, CURRENT_TIMESTAMP),
        heartbeat_at=CURRENT_TIMESTAMP, worker_id=COALESCE(worker_id, ?)
    WHERE id=?
  `).run(workerId, runId);

  let browser;
  let totalIssues = 0;
  let pagesScanned = 0;
  let cleanPages = 0;
  const looseIssues = [];
  let firstTracePath = null;
  let firstVideoPath = null;

  const addLooseIssue = (severity, category, message, details = '') => {
    looseIssues.push({ severity, category, message, details: String(details || '') });
  };

  try {
    browser = await chromium.launch({ headless: true });
    const viewportNames = parseViewports(project);

    for (const viewportName of viewportNames) {
      const viewport = VIEWPORTS[viewportName] || VIEWPORTS.desktop;
      let context;
      let page;
      let traceStarted = false;
      let videoHandle = null;

      try {
        context = await browser.newContext({
          viewport,
          userAgent: `QADeck/0.3 Playwright QA Runner (${viewportName})`,
          recordVideo: project.enable_video ? { dir: videoDir, size: viewport } : undefined
        });
        if (project.enable_trace) {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          traceStarted = true;
        }
        page = await context.newPage();
        videoHandle = page.video();
        page.setDefaultTimeout(pageTimeout);

        db.prepare(`UPDATE test_runs SET current_url=?, heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(project.login_url || project.base_url, runId);
        await attemptLogin(page, project, addLooseIssue, viewportName);

        const startUrl = cleanUrl(project.base_url, project.base_url);
        if (!startUrl) throw new Error('Invalid project Base URL');
        const origin = new URL(startUrl).origin;
        const queue = [startUrl];
        const seen = new Set();
        let profilePages = 0;

        while (queue.length && profilePages < maxPagesPerViewport) {
          const url = queue.shift();
          if (!url || seen.has(url)) continue;
          seen.add(url);
          if (dangerousPath.test(new URL(url).pathname)) continue;

          db.prepare(`UPDATE test_runs SET current_url=?, heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(url, runId);

          const pageIssues = [];
          const issueKeys = new Set();
          const addPageIssue = (severity, category, message, details = '') => {
            const key = `${category}|${message}|${details}`;
            if (issueKeys.has(key)) return;
            issueKeys.add(key);
            pageIssues.push({ severity, category, message, details: String(details || '') });
          };

          const onConsole = (msg) => {
            if (msg.type() === 'error') addPageIssue('medium', 'console', 'Browser console error', msg.text());
          };
          const onPageError = (error) => addPageIssue('high', 'javascript', 'Uncaught JavaScript error', error.message);
          const onRequestFailed = (request) => addPageIssue('medium', 'network', 'Network request failed', `${request.method()} ${request.url()} — ${request.failure()?.errorText || 'unknown error'}`);
          const onResponse = (response) => {
            if (response.status() >= 400) addPageIssue(severityForStatus(response.status()), 'http', `HTTP ${response.status()} response`, response.url());
          };

          page.on('console', onConsole);
          page.on('pageerror', onPageError);
          page.on('requestfailed', onRequestFailed);
          page.on('response', onResponse);

          let mainStatus = null;
          const started = Date.now();
          try {
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
            mainStatus = response ? response.status() : null;
            await page.waitForTimeout(400);
          } catch (error) {
            addPageIssue('critical', 'navigation', 'Page navigation failed', error.message);
          }

          const durationMs = Date.now() - started;
          const title = await page.title().catch(() => '');
          const screenshotFile = `${viewportName}-page-${profilePages + 1}.png`;
          const screenshotAbsolute = path.join(runDir, screenshotFile);
          const screenshotWeb = `/artifacts/${runId}/${screenshotFile}`;

          try {
            await page.screenshot({ path: screenshotAbsolute, fullPage: true });
          } catch (error) {
            addPageIssue('low', 'screenshot', 'Could not capture screenshot', error.message);
          }

          try {
            const brokenImages = await page.locator('img').evaluateAll((imgs) => imgs
              .filter((img) => img.complete && img.naturalWidth === 0)
              .map((img) => img.currentSrc || img.src || img.alt || 'unknown image')
              .slice(0, 10));
            for (const image of brokenImages) addPageIssue('medium', 'asset', 'Broken image detected', image);
          } catch {}

          try {
            const layout = await page.evaluate(() => ({
              overflow: document.documentElement.scrollWidth > window.innerWidth + 4,
              viewportWidth: window.innerWidth,
              documentWidth: document.documentElement.scrollWidth
            }));
            if (layout.overflow) addPageIssue('medium', 'responsive', `Horizontal overflow on ${viewportName}`, `Viewport ${layout.viewportWidth}px, document ${layout.documentWidth}px.`);
          } catch {}

          let accessibilityCount = 0;
          if (project.enable_accessibility) accessibilityCount = await runAccessibility(page, addPageIssue);

          let baselinePath = null;
          let diffPath = null;
          let visualChangePct = null;
          if (project.enable_visual && fs.existsSync(screenshotAbsolute)) {
            const baseline = baselineInfo(project.id, viewportName, url);
            baselinePath = baseline.web;
            fs.mkdirSync(path.dirname(baseline.absolute), { recursive: true });
            if (!fs.existsSync(baseline.absolute)) {
              fs.copyFileSync(screenshotAbsolute, baseline.absolute);
              visualChangePct = 0;
            } else {
              const diffFile = `${viewportName}-diff-${profilePages + 1}.png`;
              const diffAbsolute = path.join(runDir, diffFile);
              const visual = compareVisual(screenshotAbsolute, baseline.absolute, diffAbsolute);
              visualChangePct = Number(visual.changedPct.toFixed(4));
              if (visual.diffWritten) diffPath = `/artifacts/${runId}/${diffFile}`;
              if (visual.dimensionChanged) {
                addPageIssue('high', 'visual', `Visual dimensions changed on ${viewportName}`, 'Current screenshot dimensions do not match the approved baseline.');
              } else if (visual.changedPct > visualThresholdPct) {
                addPageIssue('medium', 'visual', `Visual regression detected on ${viewportName}`, `${visual.changedPct.toFixed(2)}% of pixels changed from the approved baseline.`);
              }
            }
          }

          const pageResult = db.prepare(`
            INSERT INTO test_pages (
              run_id, url, title, status_code, screenshot_path, duration_ms,
              viewport, baseline_path, diff_path, visual_change_pct, accessibility_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            runId, url, title, mainStatus, screenshotWeb, durationMs,
            viewportName, baselinePath, diffPath, visualChangePct, accessibilityCount
          );
          const pageId = Number(pageResult.lastInsertRowid);

          const issueStmt = db.prepare(`
            INSERT INTO test_issues (run_id, page_id, severity, category, message, details)
            VALUES (?, ?, ?, ?, ?, ?)
          `);
          for (const issue of pageIssues) issueStmt.run(runId, pageId, issue.severity, issue.category, issue.message, issue.details);

          totalIssues += pageIssues.length;
          pagesScanned += 1;
          profilePages += 1;
          if (pageIssues.length === 0) cleanPages += 1;
          updateProgress(runId, pagesScanned, totalIssues, cleanPages, `${viewportName}: ${url}`);

          try {
            const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => a.href));
            for (const raw of links) {
              const discovered = cleanUrl(raw, url);
              if (!discovered) continue;
              const parsed = new URL(discovered);
              if (parsed.origin !== origin) continue;
              if (dangerousPath.test(parsed.pathname)) continue;
              if (!seen.has(discovered) && !queue.includes(discovered)) queue.push(discovered);
            }
          } catch {}

          page.off('console', onConsole);
          page.off('pageerror', onPageError);
          page.off('requestfailed', onRequestFailed);
          page.off('response', onResponse);
        }
      } catch (error) {
        addLooseIssue('high', 'runner', `Viewport run failed: ${viewportName}`, error.message);
      } finally {
        if (context && traceStarted) {
          const traceFile = `trace-${viewportName}.zip`;
          const traceAbsolute = path.join(runDir, traceFile);
          try {
            await context.tracing.stop({ path: traceAbsolute });
            if (!firstTracePath) firstTracePath = `/artifacts/${runId}/${traceFile}`;
          } catch {}
        }
        if (context) await context.close().catch(() => {});
        if (videoHandle) {
          try {
            const videoAbsolute = await videoHandle.path();
            if (videoAbsolute && fs.existsSync(videoAbsolute) && !firstVideoPath) {
              firstVideoPath = `/artifacts/${path.relative(artifactRoot, videoAbsolute).split(path.sep).join('/')}`;
            }
          } catch {}
        }
      }
    }

    const looseStmt = db.prepare(`
      INSERT INTO test_issues (run_id, page_id, severity, category, message, details)
      VALUES (?, NULL, ?, ?, ?, ?)
    `);
    for (const issue of looseIssues) looseStmt.run(runId, issue.severity, issue.category, issue.message, issue.details);
    totalIssues += looseIssues.length;
    updateProgress(runId, pagesScanned, totalIssues, cleanPages, null);

    db.prepare(`
      UPDATE test_runs
      SET status='completed', completed_at=CURRENT_TIMESTAMP,
          pages_scanned=?, issues_count=?, clean_pages=?, trace_path=?, video_path=?,
          current_url=NULL, heartbeat_at=NULL, worker_id=NULL
      WHERE id=?
    `).run(pagesScanned, totalIssues, cleanPages, firstTracePath, firstVideoPath, runId);
  } catch (error) {
    db.prepare(`
      UPDATE test_runs
      SET status='failed', completed_at=CURRENT_TIMESTAMP,
          pages_scanned=?, issues_count=?, clean_pages=?, error_message=?,
          trace_path=?, video_path=?, current_url=NULL, heartbeat_at=NULL, worker_id=NULL
      WHERE id=?
    `).run(pagesScanned, totalIssues, cleanPages, error.message, firstTracePath, firstVideoPath, runId);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runProject };
