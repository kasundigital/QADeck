const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const artifactRoot = path.join(dataDir, 'artifacts');
const VIEWPORT_OPTIONS = ['desktop', 'laptop', 'tablet', 'mobile', 'small-mobile'];
const SCENARIO_ACTIONS = ['visit', 'click', 'fill', 'select', 'check', 'uncheck', 'expect_text', 'expect_url', 'wait', 'screenshot'];

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(process.cwd(), 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'qadeck-dev-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true',
    maxAge: 12 * 60 * 60 * 1000
  }
}));

app.locals.formatDate = (value) => value ? new Date(`${value.replace(' ', 'T')}Z`).toLocaleString() : '—';
app.locals.issueClass = (severity) => ({ critical: 'danger', high: 'danger', medium: 'warning', low: 'info' }[severity] || 'muted');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.redirect('/login');
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function parseExtraLoginFields(body) {
  const names = asArray(body.extra_field_name);
  const values = asArray(body.extra_field_value);
  const selectors = asArray(body.extra_field_selector);
  const types = asArray(body.extra_field_type);
  const count = Math.max(names.length, values.length, selectors.length, types.length);
  const fields = [];

  for (let i = 0; i < count; i += 1) {
    const name = String(names[i] || '').trim();
    const value = String(values[i] || '');
    const selector = String(selectors[i] || '').trim();
    const requestedType = String(types[i] || 'auto').toLowerCase();
    const type = ['auto', 'text', 'password', 'select'].includes(requestedType) ? requestedType : 'auto';
    if (!name && !selector) continue;
    fields.push({ name, value, selector, type });
  }

  return fields.slice(0, 20);
}

function encryptExtraLoginFields(fields) {
  if (!fields.length) return null;
  return encrypt(JSON.stringify(fields));
}

function decryptExtraLoginFields(project) {
  if (!project?.extra_login_fields_enc) return [];
  try {
    const parsed = JSON.parse(decrypt(project.extra_login_fields_enc));
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function parseViewportProfiles(body) {
  const values = asArray(body.viewport_profiles).map((value) => String(value));
  const valid = [...new Set(values.filter((value) => VIEWPORT_OPTIONS.includes(value)))];
  return valid.length ? valid : ['desktop'];
}

function getViewportProfiles(project) {
  try {
    const parsed = JSON.parse(project?.viewport_profiles || '[]');
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((value) => VIEWPORT_OPTIONS.includes(value));
      if (valid.length) return valid;
    }
  } catch {}
  return ['desktop'];
}

function featureValue(body, name) {
  return body[name] === '1' ? 1 : 0;
}

function parseScenarioSteps(body) {
  const actions = asArray(body.step_action);
  const targets = asArray(body.step_target);
  const values = asArray(body.step_value);
  const count = Math.max(actions.length, targets.length, values.length);
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const action = String(actions[i] || '').trim().toLowerCase();
    if (!SCENARIO_ACTIONS.includes(action)) continue;
    steps.push({
      action,
      target: String(targets[i] || '').trim(),
      value: String(values[i] || '')
    });
  }
  return steps.slice(0, 100);
}

function saveScenarioSteps(scenarioId, steps) {
  db.prepare('DELETE FROM scenario_steps WHERE scenario_id=?').run(scenarioId);
  const insert = db.prepare('INSERT INTO scenario_steps (scenario_id, position, action, target, value) VALUES (?, ?, ?, ?, ?)');
  const transaction = db.transaction(() => {
    steps.forEach((step, index) => insert.run(scenarioId, index + 1, step.action, step.target || null, step.value || null));
  });
  transaction();
}

function artifactAbsolute(webPath) {
  if (!webPath || !String(webPath).startsWith('/artifacts/')) return null;
  const relative = String(webPath).slice('/artifacts/'.length);
  const resolved = path.resolve(artifactRoot, relative);
  if (resolved !== artifactRoot && !resolved.startsWith(`${artifactRoot}${path.sep}`)) return null;
  return resolved;
}

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'QADeck', version: '0.3.0', mode: 'web' }));

app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const configuredEmail = process.env.QADECK_ADMIN_EMAIL || 'admin@example.com';
  const configuredPassword = process.env.QADECK_ADMIN_PASSWORD || 'change-this-password';
  if (safeEqual(req.body.email, configuredEmail) && safeEqual(req.body.password, configuredPassword)) {
    req.session.authenticated = true;
    req.session.email = configuredEmail;
    return res.redirect('/');
  }
  return res.status(401).render('login', { error: 'Invalid email or password.' });
});

app.post('/logout', requireAuth, (req, res) => req.session.destroy(() => res.redirect('/login')));

app.use(requireAuth);
app.use('/artifacts', express.static(artifactRoot));

app.get('/', (req, res) => {
  const projects = db.prepare(`
    SELECT p.*,
      (SELECT id FROM test_runs r WHERE r.project_id=p.id ORDER BY r.id DESC LIMIT 1) AS last_run_id,
      (SELECT status FROM test_runs r WHERE r.project_id=p.id ORDER BY r.id DESC LIMIT 1) AS last_status,
      (SELECT pages_scanned FROM test_runs r WHERE r.project_id=p.id ORDER BY r.id DESC LIMIT 1) AS last_pages,
      (SELECT issues_count FROM test_runs r WHERE r.project_id=p.id ORDER BY r.id DESC LIMIT 1) AS last_issues,
      (SELECT completed_at FROM test_runs r WHERE r.project_id=p.id ORDER BY r.id DESC LIMIT 1) AS last_completed
    FROM projects p ORDER BY p.id DESC
  `).all();

  const totals = {
    projects: db.prepare('SELECT COUNT(*) AS c FROM projects').get().c,
    runs: db.prepare('SELECT COUNT(*) AS c FROM test_runs').get().c,
    issues: db.prepare('SELECT COUNT(*) AS c FROM test_issues').get().c,
    running: db.prepare("SELECT COUNT(*) AS c FROM test_runs WHERE status IN ('queued','running')").get().c
  };

  res.render('dashboard', { projects, totals, email: req.session.email });
});

app.get('/projects/new', (req, res) => res.render('project-form', {
  project: null,
  extraLoginFields: [],
  viewportProfiles: ['desktop', 'tablet', 'mobile'],
  error: null
}));

app.post('/projects', (req, res) => {
  const name = String(req.body.name || '').trim();
  const baseUrl = String(req.body.base_url || '').trim();
  const extraLoginFields = parseExtraLoginFields(req.body);
  const viewportProfiles = parseViewportProfiles(req.body);
  if (!name || !baseUrl) return res.status(400).render('project-form', { project: req.body, extraLoginFields, viewportProfiles, error: 'Project name and Base URL are required.' });
  try { new URL(baseUrl); } catch { return res.status(400).render('project-form', { project: req.body, extraLoginFields, viewportProfiles, error: 'Please enter a valid Base URL.' }); }

  const result = db.prepare(`
    INSERT INTO projects (
      name, base_url, login_url, username, password_enc, extra_login_fields_enc,
      viewport_profiles, enable_visual, enable_accessibility, enable_trace, enable_video
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    baseUrl,
    String(req.body.login_url || '').trim() || null,
    String(req.body.username || '').trim() || null,
    encrypt(req.body.password || ''),
    encryptExtraLoginFields(extraLoginFields),
    JSON.stringify(viewportProfiles),
    featureValue(req.body, 'enable_visual'),
    featureValue(req.body, 'enable_accessibility'),
    featureValue(req.body, 'enable_trace'),
    featureValue(req.body, 'enable_video')
  );

  res.redirect(`/projects/${result.lastInsertRowid}`);
});

app.get('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const runs = db.prepare('SELECT * FROM test_runs WHERE project_id=? ORDER BY id DESC LIMIT 30').all(project.id);
  const scenarios = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM scenario_steps st WHERE st.scenario_id=s.id) AS step_count
    FROM test_scenarios s WHERE s.project_id=? ORDER BY s.id DESC
  `).all(project.id);
  res.render('project', { project, runs, scenarios, viewportProfiles: getViewportProfiles(project) });
});

app.get('/projects/:id/edit', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  res.render('project-form', {
    project,
    extraLoginFields: decryptExtraLoginFields(project),
    viewportProfiles: getViewportProfiles(project),
    error: null
  });
});

app.post('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const name = String(req.body.name || '').trim();
  const baseUrl = String(req.body.base_url || '').trim();
  const extraLoginFields = parseExtraLoginFields(req.body);
  const viewportProfiles = parseViewportProfiles(req.body);
  if (!name || !baseUrl) return res.status(400).render('project-form', { project: { ...project, ...req.body }, extraLoginFields, viewportProfiles, error: 'Project name and Base URL are required.' });
  try { new URL(baseUrl); } catch { return res.status(400).render('project-form', { project: { ...project, ...req.body }, extraLoginFields, viewportProfiles, error: 'Please enter a valid Base URL.' }); }

  const passwordSql = req.body.password ? ', password_enc=?' : '';
  const params = [
    name,
    baseUrl,
    String(req.body.login_url || '').trim() || null,
    String(req.body.username || '').trim() || null,
    encryptExtraLoginFields(extraLoginFields),
    JSON.stringify(viewportProfiles),
    featureValue(req.body, 'enable_visual'),
    featureValue(req.body, 'enable_accessibility'),
    featureValue(req.body, 'enable_trace'),
    featureValue(req.body, 'enable_video')
  ];
  if (req.body.password) params.push(encrypt(req.body.password));
  params.push(project.id);

  db.prepare(`
    UPDATE projects
    SET name=?, base_url=?, login_url=?, username=?, extra_login_fields_enc=?,
        viewport_profiles=?, enable_visual=?, enable_accessibility=?, enable_trace=?, enable_video=?
        ${passwordSql}, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(...params);
  res.redirect(`/projects/${project.id}`);
});

app.post('/projects/:id/delete', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.redirect('/');
});

app.post('/projects/:id/run', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const active = db.prepare("SELECT id FROM test_runs WHERE project_id=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(project.id);
  if (active) return res.redirect(`/runs/${active.id}`);
  const result = db.prepare(`INSERT INTO test_runs (project_id, status, queued_at, run_type) VALUES (?, 'queued', CURRENT_TIMESTAMP, 'crawl')`).run(project.id);
  res.redirect(`/runs/${Number(result.lastInsertRowid)}`);
});

app.get('/projects/:id/scenarios/new', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  res.render('scenario-form', { project, scenario: null, steps: [], error: null });
});

app.post('/projects/:id/scenarios', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const steps = parseScenarioSteps(req.body);
  if (!name || !steps.length) return res.status(400).render('scenario-form', { project, scenario: req.body, steps, error: 'Scenario name and at least one step are required.' });
  const result = db.prepare('INSERT INTO test_scenarios (project_id, name, description) VALUES (?, ?, ?)').run(project.id, name, description || null);
  saveScenarioSteps(Number(result.lastInsertRowid), steps);
  res.redirect(`/projects/${project.id}`);
});

app.get('/scenarios/:id/edit', (req, res) => {
  const scenario = db.prepare('SELECT * FROM test_scenarios WHERE id=?').get(req.params.id);
  if (!scenario) return res.status(404).send('Scenario not found');
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(scenario.project_id);
  const steps = db.prepare('SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY position').all(scenario.id);
  res.render('scenario-form', { project, scenario, steps, error: null });
});

app.post('/scenarios/:id', (req, res) => {
  const scenario = db.prepare('SELECT * FROM test_scenarios WHERE id=?').get(req.params.id);
  if (!scenario) return res.status(404).send('Scenario not found');
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(scenario.project_id);
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const steps = parseScenarioSteps(req.body);
  if (!name || !steps.length) return res.status(400).render('scenario-form', { project, scenario: { ...scenario, ...req.body }, steps, error: 'Scenario name and at least one step are required.' });
  db.prepare('UPDATE test_scenarios SET name=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, description || null, scenario.id);
  saveScenarioSteps(scenario.id, steps);
  res.redirect(`/projects/${scenario.project_id}`);
});

app.post('/scenarios/:id/delete', (req, res) => {
  const scenario = db.prepare('SELECT * FROM test_scenarios WHERE id=?').get(req.params.id);
  if (!scenario) return res.status(404).send('Scenario not found');
  db.prepare('DELETE FROM test_scenarios WHERE id=?').run(scenario.id);
  res.redirect(`/projects/${scenario.project_id}`);
});

app.post('/scenarios/:id/run', (req, res) => {
  const scenario = db.prepare('SELECT * FROM test_scenarios WHERE id=?').get(req.params.id);
  if (!scenario) return res.status(404).send('Scenario not found');
  const active = db.prepare("SELECT id FROM test_runs WHERE project_id=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(scenario.project_id);
  if (active) return res.redirect(`/runs/${active.id}`);
  const result = db.prepare(`
    INSERT INTO test_runs (project_id, status, queued_at, run_type, scenario_id)
    VALUES (?, 'queued', CURRENT_TIMESTAMP, 'scenario', ?)
  `).run(scenario.project_id, scenario.id);
  res.redirect(`/runs/${Number(result.lastInsertRowid)}`);
});

app.get('/runs/:id', (req, res) => {
  const run = db.prepare(`SELECT r.*, p.name AS project_name, p.base_url FROM test_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?`).get(req.params.id);
  if (!run) return res.status(404).send('Run not found');
  const pages = db.prepare('SELECT * FROM test_pages WHERE run_id=? ORDER BY id').all(run.id);
  const issues = db.prepare(`
    SELECT i.*, p.url AS page_url, p.screenshot_path, p.viewport
    FROM test_issues i LEFT JOIN test_pages p ON p.id=i.page_id
    WHERE i.run_id=?
    ORDER BY CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, i.id
  `).all(run.id);
  const scenario = run.scenario_id ? db.prepare('SELECT * FROM test_scenarios WHERE id=?').get(run.scenario_id) : null;
  const stepResults = run.scenario_id ? db.prepare('SELECT * FROM scenario_step_results WHERE run_id=? ORDER BY position').all(run.id) : [];
  res.render('run', { run, pages, issues, scenario, stepResults });
});

app.post('/pages/:id/approve-baseline', (req, res) => {
  const page = db.prepare(`
    SELECT tp.*, tr.project_id, tr.id AS run_id
    FROM test_pages tp JOIN test_runs tr ON tr.id=tp.run_id
    WHERE tp.id=?
  `).get(req.params.id);
  if (!page) return res.status(404).send('Page result not found');
  const source = artifactAbsolute(page.screenshot_path);
  if (!source || !fs.existsSync(source)) return res.status(400).send('Current screenshot is not available');

  let baselinePath = page.baseline_path;
  if (!baselinePath) {
    const hash = crypto.createHash('sha1').update(page.url).digest('hex').slice(0, 20);
    baselinePath = `/artifacts/baselines/${page.project_id}/${page.viewport || 'desktop'}/${hash}.png`;
  }
  const destination = artifactAbsolute(baselinePath);
  if (!destination) return res.status(400).send('Invalid baseline path');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);

  if (page.diff_path) {
    const diff = artifactAbsolute(page.diff_path);
    if (diff && fs.existsSync(diff)) fs.rmSync(diff, { force: true });
  }
  db.prepare('UPDATE test_pages SET baseline_path=?, diff_path=NULL, visual_change_pct=0 WHERE id=?').run(baselinePath, page.id);
  res.redirect(`/runs/${page.run_id}`);
});

app.get('/api/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM test_runs WHERE id=?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  const latestPages = db.prepare(`
    SELECT id, url, title, status_code, screenshot_path, duration_ms, viewport,
           baseline_path, diff_path, visual_change_pct, accessibility_count
    FROM test_pages WHERE run_id=? ORDER BY id DESC LIMIT 10
  `).all(run.id);
  const latestIssues = db.prepare(`SELECT id, severity, category, message, details, page_id FROM test_issues WHERE run_id=? ORDER BY id DESC LIMIT 20`).all(run.id);
  const latestSteps = db.prepare(`SELECT id, position, action, status, message, screenshot_path FROM scenario_step_results WHERE run_id=? ORDER BY position DESC LIMIT 20`).all(run.id);
  res.json({ ...run, latest_pages: latestPages, latest_issues: latestIssues, latest_steps: latestSteps });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('QADeck encountered an unexpected error.');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`QADeck web listening on http://0.0.0.0:${port}`);
});
