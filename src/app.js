const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

const app = express();
const port = Number(process.env.PORT || 3000);

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
app.use('/artifacts', express.static(path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts')));

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

app.get('/projects/new', (req, res) => res.render('project-form', { project: null, extraLoginFields: [], error: null }));

app.post('/projects', (req, res) => {
  const name = String(req.body.name || '').trim();
  const baseUrl = String(req.body.base_url || '').trim();
  const extraLoginFields = parseExtraLoginFields(req.body);
  if (!name || !baseUrl) return res.status(400).render('project-form', { project: req.body, extraLoginFields, error: 'Project name and Base URL are required.' });

  try { new URL(baseUrl); } catch { return res.status(400).render('project-form', { project: req.body, extraLoginFields, error: 'Please enter a valid Base URL.' }); }

  const result = db.prepare(`
    INSERT INTO projects (name, base_url, login_url, username, password_enc, extra_login_fields_enc)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    baseUrl,
    String(req.body.login_url || '').trim() || null,
    String(req.body.username || '').trim() || null,
    encrypt(req.body.password || ''),
    encryptExtraLoginFields(extraLoginFields)
  );

  res.redirect(`/projects/${result.lastInsertRowid}`);
});

app.get('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const runs = db.prepare('SELECT * FROM test_runs WHERE project_id=? ORDER BY id DESC LIMIT 30').all(project.id);
  res.render('project', { project, runs });
});

app.get('/projects/:id/edit', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  res.render('project-form', { project, extraLoginFields: decryptExtraLoginFields(project), error: null });
});

app.post('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).send('Project not found');
  const name = String(req.body.name || '').trim();
  const baseUrl = String(req.body.base_url || '').trim();
  const extraLoginFields = parseExtraLoginFields(req.body);
  if (!name || !baseUrl) return res.status(400).render('project-form', { project: { ...project, ...req.body }, extraLoginFields, error: 'Project name and Base URL are required.' });
  try { new URL(baseUrl); } catch { return res.status(400).render('project-form', { project: { ...project, ...req.body }, extraLoginFields, error: 'Please enter a valid Base URL.' }); }

  const passwordSql = req.body.password ? ', password_enc=?' : '';
  const params = [
    name,
    baseUrl,
    String(req.body.login_url || '').trim() || null,
    String(req.body.username || '').trim() || null,
    encryptExtraLoginFields(extraLoginFields)
  ];
  if (req.body.password) params.push(encrypt(req.body.password));
  params.push(project.id);

  db.prepare(`
    UPDATE projects
    SET name=?, base_url=?, login_url=?, username=?, extra_login_fields_enc=?${passwordSql}, updated_at=CURRENT_TIMESTAMP
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

  const result = db.prepare(`
    INSERT INTO test_runs (project_id, status, queued_at)
    VALUES (?, 'queued', CURRENT_TIMESTAMP)
  `).run(project.id);

  res.redirect(`/runs/${Number(result.lastInsertRowid)}`);
});

app.get('/runs/:id', (req, res) => {
  const run = db.prepare(`SELECT r.*, p.name AS project_name, p.base_url FROM test_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?`).get(req.params.id);
  if (!run) return res.status(404).send('Run not found');
  const pages = db.prepare('SELECT * FROM test_pages WHERE run_id=? ORDER BY id').all(run.id);
  const issues = db.prepare(`
    SELECT i.*, p.url AS page_url, p.screenshot_path
    FROM test_issues i LEFT JOIN test_pages p ON p.id=i.page_id
    WHERE i.run_id=?
    ORDER BY CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, i.id
  `).all(run.id);
  res.render('run', { run, pages, issues });
});

app.get('/api/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM test_runs WHERE id=?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });

  const latestPages = db.prepare(`
    SELECT id, url, title, status_code, screenshot_path, duration_ms
    FROM test_pages WHERE run_id=? ORDER BY id DESC LIMIT 5
  `).all(run.id);

  const latestIssues = db.prepare(`
    SELECT id, severity, category, message, details, page_id
    FROM test_issues WHERE run_id=? ORDER BY id DESC LIMIT 10
  `).all(run.id);

  res.json({ ...run, latest_pages: latestPages, latest_issues: latestIssues });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('QADeck encountered an unexpected error.');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`QADeck web listening on http://0.0.0.0:${port}`);
});
