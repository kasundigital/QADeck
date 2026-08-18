const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'qadeck.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  login_url TEXT,
  username TEXT,
  password_enc TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  completed_at TEXT,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  issues_count INTEGER NOT NULL DEFAULT 0,
  clean_pages INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  status_code INTEGER,
  screenshot_path TEXT,
  duration_ms INTEGER,
  FOREIGN KEY(run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  page_id INTEGER,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES test_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(page_id) REFERENCES test_pages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS test_scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scenario_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  value TEXT,
  FOREIGN KEY(scenario_id) REFERENCES test_scenarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scenario_step_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  scenario_id INTEGER NOT NULL,
  step_id INTEGER,
  position INTEGER NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  screenshot_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES test_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(scenario_id) REFERENCES test_scenarios(id) ON DELETE CASCADE,
  FOREIGN KEY(step_id) REFERENCES scenario_steps(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  login_url TEXT,
  username TEXT,
  password_enc TEXT,
  extra_login_fields_enc TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON test_runs(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON test_runs(status, id);
CREATE INDEX IF NOT EXISTS idx_pages_run ON test_pages(run_id);
CREATE INDEX IF NOT EXISTS idx_issues_run ON test_issues(run_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_project ON test_scenarios(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_scenario_steps ON scenario_steps(scenario_id, position);
CREATE INDEX IF NOT EXISTS idx_step_results_run ON scenario_step_results(run_id, position);
CREATE INDEX IF NOT EXISTS idx_roles_project ON project_roles(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notify_run ON notification_logs(run_id, id DESC);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

ensureColumn('projects', 'extra_login_fields_enc', 'TEXT');
ensureColumn('projects', 'viewport_profiles', `TEXT NOT NULL DEFAULT '["desktop"]'`);
ensureColumn('projects', 'enable_visual', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('projects', 'enable_accessibility', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('projects', 'enable_trace', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('projects', 'enable_video', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('projects', 'enable_performance', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('projects', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('projects', 'schedule_interval_minutes', 'INTEGER NOT NULL DEFAULT 1440');
ensureColumn('projects', 'schedule_last_queued_at', 'TEXT');
ensureColumn('projects', 'webhook_url_enc', 'TEXT');
ensureColumn('projects', 'telegram_chat_id', 'TEXT');
ensureColumn('projects', 'notify_email', 'TEXT');
ensureColumn('projects', 'notify_on_success', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('projects', 'notify_on_failure', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('projects', 'trigger_token', 'TEXT');
ensureColumn('projects', 'performance_budget_ms', 'INTEGER NOT NULL DEFAULT 3000');

ensureColumn('test_scenarios', 'use_project_login', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('test_scenarios', 'role_id', 'INTEGER');
ensureColumn('test_scenarios', 'retry_count', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('scenario_step_results', 'viewport', `TEXT NOT NULL DEFAULT 'desktop'`);
ensureColumn('scenario_step_results', 'attempts', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('scenario_step_results', 'flaky', 'INTEGER NOT NULL DEFAULT 0');

ensureColumn('test_runs', 'queued_at', 'TEXT');
ensureColumn('test_runs', 'heartbeat_at', 'TEXT');
ensureColumn('test_runs', 'current_url', 'TEXT');
ensureColumn('test_runs', 'worker_id', 'TEXT');
ensureColumn('test_runs', 'trace_path', 'TEXT');
ensureColumn('test_runs', 'video_path', 'TEXT');
ensureColumn('test_runs', 'run_type', `TEXT NOT NULL DEFAULT 'crawl'`);
ensureColumn('test_runs', 'scenario_id', 'INTEGER');
ensureColumn('test_runs', 'ai_summary', 'TEXT');

ensureColumn('test_pages', 'viewport', `TEXT NOT NULL DEFAULT 'desktop'`);
ensureColumn('test_pages', 'baseline_path', 'TEXT');
ensureColumn('test_pages', 'diff_path', 'TEXT');
ensureColumn('test_pages', 'visual_change_pct', 'REAL');
ensureColumn('test_pages', 'accessibility_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('test_pages', 'performance_json', 'TEXT');
ensureColumn('test_pages', 'performance_score', 'INTEGER');

db.prepare(`
  UPDATE test_runs
  SET queued_at=COALESCE(queued_at, started_at, completed_at)
  WHERE queued_at IS NULL
`).run();

module.exports = db;
