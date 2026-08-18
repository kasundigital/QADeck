const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const db = require('./db');
const { decrypt } = require('./crypto');

const maxPages = Math.max(1, Number(process.env.MAX_PAGES_PER_RUN || 20));
const pageTimeout = Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 20000));
const artifactRoot = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');

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

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible({ timeout: 500 })) return locator;
      } catch {}
    }
  }
  return null;
}

async function attemptLogin(page, project, addLooseIssue) {
  if (!project.login_url || !project.username || !project.password_enc) return;

  const loginUrl = cleanUrl(project.login_url, project.base_url);
  if (!loginUrl) {
    addLooseIssue('high', 'authentication', 'Invalid login URL', project.login_url || '');
    return;
  }

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
    const userInput = await firstVisible(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[name*="login" i]',
      'input[type="text"]'
    ]);
    const passInput = await firstVisible(page, ['input[type="password"]']);

    if (!userInput || !passInput) {
      addLooseIssue('high', 'authentication', 'QADeck could not identify the login fields', loginUrl);
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
      addLooseIssue('high', 'authentication', 'QADeck could not identify the login submit button', loginUrl);
      return;
    }

    await submit.click();
    await page.waitForLoadState('domcontentloaded', { timeout: pageTimeout }).catch(() => {});
    await page.waitForTimeout(700);

    const passwordStillVisible = await page.locator('input[type="password"]:visible').count();
    if (passwordStillVisible) {
      addLooseIssue('high', 'authentication', 'Login may have failed; password field is still visible', page.url());
    }
  } catch (error) {
    addLooseIssue('high', 'authentication', 'Login flow failed', error.message);
  }
}

function updateProgress(runId, pagesScanned, totalIssues, cleanPages, currentUrl = null) {
  db.prepare(`
    UPDATE test_runs
    SET pages_scanned=?, issues_count=?, clean_pages=?, current_url=?, heartbeat_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='running'
  `).run(pagesScanned, totalIssues, cleanPages, currentUrl, runId);
}

async function runProject(runId, project, options = {}) {
  const workerId = options.workerId || null;
  const runDir = path.join(artifactRoot, String(runId));
  fs.mkdirSync(runDir, { recursive: true });

  db.prepare(`
    UPDATE test_runs
    SET status='running', started_at=COALESCE(started_at, CURRENT_TIMESTAMP),
        heartbeat_at=CURRENT_TIMESTAMP, worker_id=COALESCE(worker_id, ?)
    WHERE id=?
  `).run(workerId, runId);

  let browser;
  let context;
  let totalIssues = 0;
  let pagesScanned = 0;
  let cleanPages = 0;
  const looseIssues = [];

  const addLooseIssue = (severity, category, message, details = '') => {
    looseIssues.push({ severity, category, message, details: String(details || '') });
  };

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'QADeck/0.2 Playwright QA Runner'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(pageTimeout);

    db.prepare(`UPDATE test_runs SET current_url=?, heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(project.login_url || project.base_url, runId);
    await attemptLogin(page, project, addLooseIssue);

    const startUrl = cleanUrl(project.base_url, project.base_url);
    if (!startUrl) throw new Error('Invalid project Base URL');
    const origin = new URL(startUrl).origin;
    const queue = [startUrl];
    const seen = new Set();

    while (queue.length && pagesScanned < maxPages) {
      const url = queue.shift();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      if (dangerousPath.test(new URL(url).pathname)) continue;

      db.prepare(`UPDATE test_runs SET current_url=?, heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(url, runId);

      const pageIssues = [];
      const requestIssueKeys = new Set();
      const addPageIssue = (severity, category, message, details = '') => {
        const key = `${category}|${message}|${details}`;
        if (requestIssueKeys.has(key)) return;
        requestIssueKeys.add(key);
        pageIssues.push({ severity, category, message, details: String(details || '') });
      };

      const onConsole = (msg) => {
        if (msg.type() === 'error') addPageIssue('medium', 'console', 'Browser console error', msg.text());
      };
      const onPageError = (error) => addPageIssue('high', 'javascript', 'Uncaught JavaScript error', error.message);
      const onRequestFailed = (request) => addPageIssue('medium', 'network', 'Network request failed', `${request.method()} ${request.url()} — ${request.failure()?.errorText || 'unknown error'}`);
      const onResponse = (response) => {
        if (response.status() >= 400) {
          addPageIssue(severityForStatus(response.status()), 'http', `HTTP ${response.status()} response`, response.url());
        }
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
        await page.waitForTimeout(350);
      } catch (error) {
        addPageIssue('critical', 'navigation', 'Page navigation failed', error.message);
      }

      const durationMs = Date.now() - started;
      const title = await page.title().catch(() => '');
      const screenshotFile = `page-${pagesScanned + 1}.png`;
      const screenshotAbsolute = path.join(runDir, screenshotFile);
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
        for (const image of brokenImages) {
          addPageIssue('medium', 'asset', 'Broken image detected', image);
        }
      } catch {}

      try {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4);
        if (overflow) addPageIssue('low', 'responsive', 'Horizontal page overflow detected', 'Page content is wider than the 1440px test viewport.');
      } catch {}

      const pageResult = db.prepare(`
        INSERT INTO test_pages (run_id, url, title, status_code, screenshot_path, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, url, title, mainStatus, `/artifacts/${runId}/${screenshotFile}`, durationMs);
      const pageId = Number(pageResult.lastInsertRowid);

      const issueStmt = db.prepare(`
        INSERT INTO test_issues (run_id, page_id, severity, category, message, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const issue of pageIssues) {
        issueStmt.run(runId, pageId, issue.severity, issue.category, issue.message, issue.details);
      }

      totalIssues += pageIssues.length;
      pagesScanned += 1;
      if (pageIssues.length === 0) cleanPages += 1;
      updateProgress(runId, pagesScanned, totalIssues, cleanPages, url);

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

    const looseStmt = db.prepare(`
      INSERT INTO test_issues (run_id, page_id, severity, category, message, details)
      VALUES (?, NULL, ?, ?, ?, ?)
    `);
    for (const issue of looseIssues) {
      looseStmt.run(runId, issue.severity, issue.category, issue.message, issue.details);
    }
    totalIssues += looseIssues.length;
    updateProgress(runId, pagesScanned, totalIssues, cleanPages, null);

    db.prepare(`
      UPDATE test_runs
      SET status='completed', completed_at=CURRENT_TIMESTAMP,
          pages_scanned=?, issues_count=?, clean_pages=?,
          current_url=NULL, heartbeat_at=NULL, worker_id=NULL
      WHERE id=?
    `).run(pagesScanned, totalIssues, cleanPages, runId);
  } catch (error) {
    db.prepare(`
      UPDATE test_runs
      SET status='failed', completed_at=CURRENT_TIMESTAMP,
          pages_scanned=?, issues_count=?, clean_pages=?, error_message=?,
          current_url=NULL, heartbeat_at=NULL, worker_id=NULL
      WHERE id=?
    `).run(pagesScanned, totalIssues, cleanPages, error.message, runId);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runProject };
