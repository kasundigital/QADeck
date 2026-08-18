const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const db = require('./db');
const { decrypt } = require('./crypto');

const pageTimeout = Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 20000));
const artifactRoot = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
  'small-mobile': { width: 360, height: 800 }
};

function enabled(value) {
  return Number(value) === 1 || value === true;
}

function cleanUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
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

async function visible(locator) {
  try {
    if (!(await locator.count())) return null;
    const first = locator.first();
    return await first.isVisible({ timeout: 500 }) ? first : null;
  } catch {
    return null;
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const found = await visible(page.locator(selector));
    if (found) return found;
  }
  return null;
}

async function findExtraField(page, field) {
  if (field.selector) {
    const found = await visible(page.locator(field.selector));
    if (found) return found;
  }

  if (!field.name) return null;

  try {
    const byLabel = await visible(page.getByLabel(field.name, { exact: false }));
    if (byLabel) return byLabel;
  } catch {}

  const safe = String(field.name).replace(/"/g, '\\"');
  return firstVisible(page, [
    `[name="${safe}"]`,
    `input[placeholder*="${safe}" i]`,
    `select[placeholder*="${safe}" i]`,
    `input[aria-label*="${safe}" i]`,
    `select[aria-label*="${safe}" i]`
  ]);
}

async function findUsernameField(page) {
  const semantic = await firstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="username" i]',
    'input[name*="user_name" i]',
    'input[name*="user" i]',
    'input[name*="login" i]',
    'input[autocomplete="username"]'
  ]);
  if (semantic) return semantic;

  try {
    const textInputs = page.locator('input[type="text"]:visible');
    const count = await textInputs.count();
    if (count) return textInputs.nth(count - 1);
  } catch {}
  return null;
}

async function attemptProjectLogin(page, project) {
  if (!project.login_url || !project.username || !project.password_enc) return;
  const loginUrl = cleanUrl(project.login_url, project.base_url);
  if (!loginUrl) throw new Error('Invalid project login URL');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: pageTimeout });

  for (const field of parseExtraLoginFields(project)) {
    const locator = await findExtraField(page, field);
    if (!locator) throw new Error(`Could not find extra login field: ${field.name || field.selector}`);
    const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
    if (field.type === 'select' || tag === 'select') {
      await locator.selectOption({ label: String(field.value || '') }).catch(() => locator.selectOption(String(field.value || '')));
    } else {
      await locator.fill(String(field.value || ''));
    }
  }

  const username = await findUsernameField(page);
  const password = await firstVisible(page, ['input[type="password"]', 'input[autocomplete="current-password"]']);
  if (!username || !password) throw new Error('Could not identify username/password fields');

  await username.fill(project.username);
  await password.fill(decrypt(project.password_enc));
  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")'
  ]);
  if (!submit) throw new Error('Could not identify login submit button');
  await submit.click();
  await page.waitForLoadState('domcontentloaded', { timeout: pageTimeout }).catch(() => {});
  await page.waitForTimeout(500);
}

function requireTarget(step) {
  if (!step.target) throw new Error(`${step.action} requires a target selector`);
  return step.target;
}

async function executeStep(page, step, project, screenshotPath) {
  switch (step.action) {
    case 'visit': {
      const raw = step.value || step.target;
      if (!raw) throw new Error('Visit requires a URL or path in Value');
      const url = cleanUrl(raw, project.base_url);
      if (!url) throw new Error(`Invalid URL: ${raw}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
      await page.waitForTimeout(250);
      return `Visited ${url}`;
    }
    case 'click':
      await page.locator(requireTarget(step)).first().click({ timeout: pageTimeout });
      await page.waitForTimeout(200);
      return `Clicked ${step.target}`;
    case 'fill':
      await page.locator(requireTarget(step)).first().fill(String(step.value || ''));
      return `Filled ${step.target}`;
    case 'select': {
      const locator = page.locator(requireTarget(step)).first();
      await locator.selectOption({ label: String(step.value || '') }).catch(() => locator.selectOption(String(step.value || '')));
      return `Selected ${step.value || ''}`;
    }
    case 'check':
      await page.locator(requireTarget(step)).first().check();
      return `Checked ${step.target}`;
    case 'uncheck':
      await page.locator(requireTarget(step)).first().uncheck();
      return `Unchecked ${step.target}`;
    case 'expect_text': {
      const locator = step.target ? page.locator(step.target).first() : page.locator('body');
      await locator.waitFor({ state: 'visible', timeout: pageTimeout });
      const text = await locator.innerText();
      const expected = String(step.value || '');
      if (!text.includes(expected)) throw new Error(`Expected text not found: ${expected}`);
      return `Found expected text: ${expected}`;
    }
    case 'expect_url': {
      const expected = String(step.value || step.target || '');
      if (!expected) throw new Error('Expect URL requires a value');
      await page.waitForURL((url) => url.href.includes(expected), { timeout: pageTimeout });
      return `URL contains ${expected}`;
    }
    case 'wait': {
      const ms = Math.min(30000, Math.max(0, Number(step.value || step.target || 1000)));
      await page.waitForTimeout(ms);
      return `Waited ${ms} ms`;
    }
    case 'screenshot':
      await page.screenshot({ path: screenshotPath, fullPage: true });
      return 'Screenshot captured';
    default:
      throw new Error(`Unsupported scenario action: ${step.action}`);
  }
}

function updateRun(runId, completed, issues, passed, current) {
  db.prepare(`
    UPDATE test_runs
    SET pages_scanned=?, issues_count=?, clean_pages=?, current_url=?, heartbeat_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(completed, issues, passed, current, runId);
}

async function runScenario(runId, project, scenarioId, options = {}) {
  const workerId = options.workerId || null;
  const scenario = db.prepare('SELECT * FROM test_scenarios WHERE id=? AND project_id=?').get(scenarioId, project.id);
  if (!scenario) throw new Error('Scenario not found');
  const steps = db.prepare('SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY position').all(scenario.id);
  if (!steps.length) throw new Error('Scenario has no steps');

  const runDir = path.join(artifactRoot, String(runId));
  const videoDir = path.join(runDir, 'videos');
  fs.mkdirSync(runDir, { recursive: true });
  if (enabled(project.enable_video)) fs.mkdirSync(videoDir, { recursive: true });

  db.prepare(`UPDATE test_runs SET status='running', started_at=COALESCE(started_at,CURRENT_TIMESTAMP), worker_id=COALESCE(worker_id,?), heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(workerId, runId);

  let browser;
  let completed = 0;
  let passed = 0;
  let issues = 0;
  let firstTracePath = null;
  let firstVideoPath = null;

  const insertResult = db.prepare(`
    INSERT INTO scenario_step_results (run_id, scenario_id, step_id, position, action, status, message, screenshot_path, viewport)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIssue = db.prepare(`INSERT INTO test_issues (run_id, page_id, severity, category, message, details) VALUES (?, NULL, ?, ?, ?, ?)`);

  try {
    browser = await chromium.launch({ headless: true });
    for (const viewportName of parseViewports(project)) {
      const viewport = VIEWPORTS[viewportName] || VIEWPORTS.desktop;
      let context;
      let page;
      let videoHandle = null;
      let traceStarted = false;
      let viewportFailed = false;

      try {
        context = await browser.newContext({
          viewport,
          userAgent: `QADeck/0.4 Scenario Runner (${viewportName})`,
          recordVideo: enabled(project.enable_video) ? { dir: videoDir, size: viewport } : undefined
        });
        if (enabled(project.enable_trace)) {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          traceStarted = true;
        }
        page = await context.newPage();
        videoHandle = page.video();
        page.setDefaultTimeout(pageTimeout);

        if (enabled(scenario.use_project_login) && project.login_url) {
          try {
            await attemptProjectLogin(page, project);
          } catch (error) {
            issues += 1;
            insertIssue.run(runId, 'high', 'scenario', `Project login failed before scenario: ${scenario.name}`, `${viewportName}: ${error.message}`);
          }
        }

        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index];
          const current = `${viewportName}: step ${step.position} ${step.action}`;
          updateRun(runId, completed, issues, passed, current);
          const screenshotFile = `scenario-${scenario.id}-${viewportName}-step-${step.position}.png`;
          const screenshotAbsolute = path.join(runDir, screenshotFile);
          const screenshotWeb = `/artifacts/${runId}/${screenshotFile}`;

          try {
            const message = await executeStep(page, step, project, screenshotAbsolute);
            completed += 1;
            passed += 1;
            const savedScreenshot = step.action === 'screenshot' && fs.existsSync(screenshotAbsolute) ? screenshotWeb : null;
            insertResult.run(runId, scenario.id, step.id, step.position, step.action, 'pass', message, savedScreenshot, viewportName);
            updateRun(runId, completed, issues, passed, current);
          } catch (error) {
            completed += 1;
            issues += 1;
            viewportFailed = true;
            try { await page.screenshot({ path: screenshotAbsolute, fullPage: true }); } catch {}
            const savedScreenshot = fs.existsSync(screenshotAbsolute) ? screenshotWeb : null;
            insertResult.run(runId, scenario.id, step.id, step.position, step.action, 'fail', error.message, savedScreenshot, viewportName);
            insertIssue.run(runId, 'high', 'scenario', `Scenario step ${step.position} failed: ${step.action}`, `${viewportName}: ${error.message}`);
            updateRun(runId, completed, issues, passed, current);

            for (const remaining of steps.slice(index + 1)) {
              insertResult.run(runId, scenario.id, remaining.id, remaining.position, remaining.action, 'skipped', 'Skipped after an earlier step failed.', null, viewportName);
            }
            break;
          }
        }
      } catch (error) {
        issues += 1;
        viewportFailed = true;
        insertIssue.run(runId, 'high', 'scenario', `Scenario viewport failed: ${viewportName}`, error.message);
      } finally {
        if (context && traceStarted) {
          const traceFile = `scenario-trace-${viewportName}.zip`;
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
        if (!viewportFailed) updateRun(runId, completed, issues, passed, null);
      }
    }

    db.prepare(`
      UPDATE test_runs SET status='completed', completed_at=CURRENT_TIMESTAMP,
        pages_scanned=?, issues_count=?, clean_pages=?, trace_path=?, video_path=?,
        current_url=NULL, heartbeat_at=NULL, worker_id=NULL
      WHERE id=?
    `).run(completed, issues, passed, firstTracePath, firstVideoPath, runId);
  } catch (error) {
    db.prepare(`
      UPDATE test_runs SET status='failed', completed_at=CURRENT_TIMESTAMP,
        pages_scanned=?, issues_count=?, clean_pages=?, error_message=?, trace_path=?, video_path=?,
        current_url=NULL, heartbeat_at=NULL, worker_id=NULL
      WHERE id=?
    `).run(completed, issues, passed, error.message, firstTracePath, firstVideoPath, runId);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runScenario };
