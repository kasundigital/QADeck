const db = require('./db');
const { decrypt } = require('./crypto');

function ensureAgentSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      project_id INTEGER PRIMARY KEY,
      repository TEXT,
      branch TEXT,
      github_token_enc TEXT,
      enable_code_review INTEGER NOT NULL DEFAULT 1,
      enable_security INTEGER NOT NULL DEFAULT 1,
      enable_test_suggestions INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      ref TEXT,
      commit_sha TEXT,
      pr_number INTEGER,
      started_at TEXT,
      completed_at TEXT,
      heartbeat_at TEXT,
      worker_id TEXT,
      files_scanned INTEGER NOT NULL DEFAULT 0,
      findings_count INTEGER NOT NULL DEFAULT 0,
      suggestions_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_run_id INTEGER NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      file_path TEXT,
      line_number INTEGER,
      title TEXT NOT NULL,
      details TEXT,
      recommendation TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_test_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_run_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      test_type TEXT NOT NULL DEFAULT 'browser',
      priority TEXT NOT NULL DEFAULT 'medium',
      rationale TEXT,
      steps_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, id);
    CREATE INDEX IF NOT EXISTS idx_agent_findings_run ON agent_findings(agent_run_id, id);
    CREATE INDEX IF NOT EXISTS idx_agent_suggestions_run ON agent_test_suggestions(agent_run_id, id);
  `);
}

ensureAgentSchema();

function normalizeRepository(raw) {
  const value = String(raw || '').trim().replace(/\/$/, '').replace(/\.git$/, '');
  if (!value) return null;
  const match = value.match(/(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function githubHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'QADeck-Agent/0.6',
    'x-github-api-version': '2022-11-28'
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(path, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: githubHeaders(token),
      signal: controller.signal
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`GitHub API HTTP ${response.status}: ${message.slice(0, 180)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function tokenFor(config) {
  if (config?.github_token_enc) {
    try { return decrypt(config.github_token_enc); } catch {}
  }
  return process.env.GITHUB_TOKEN || process.env.QADECK_GITHUB_TOKEN || '';
}

const SOURCE_EXTENSIONS = new Set([
  '.js','.mjs','.cjs','.ts','.tsx','.jsx','.php','.py','.go','.rb','.java','.cs',
  '.html','.htm','.ejs','.vue','.svelte','.css','.scss','.sql','.yml','.yaml',
  '.json','.xml','.sh','.ps1','.env','.toml','.ini'
]);
const SPECIAL_FILES = new Set(['Dockerfile','docker-compose.yml','docker-compose.yaml','compose.yml','compose.yaml','package.json','composer.json','requirements.txt','pyproject.toml']);

function isReviewable(path) {
  const lower = path.toLowerCase();
  if (lower.includes('/node_modules/') || lower.includes('/vendor/') || lower.includes('/dist/') || lower.includes('/build/')) return false;
  const name = path.split('/').pop();
  if (SPECIAL_FILES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

async function loadRepository(config, run) {
  const repository = normalizeRepository(config.repository);
  if (!repository) throw new Error('Configure a GitHub repository first (owner/repo or GitHub URL).');
  const token = tokenFor(config);
  const meta = await githubJson(`/repos/${repository}`, token);
  let branch = String(run.ref || config.branch || meta.default_branch || 'main');
  let sha = run.commit_sha || null;
  let rawPaths = [];

  if (run.pr_number) {
    const pr = await githubJson(`/repos/${repository}/pulls/${Number(run.pr_number)}`, token);
    sha = sha || pr.head?.sha;
    branch = pr.head?.ref || branch;
    const changed = await githubJson(`/repos/${repository}/pulls/${Number(run.pr_number)}/files?per_page=100`, token);
    rawPaths = (Array.isArray(changed) ? changed : []).map((item)=>({path:item.filename,type:'blob',size:Number(item.changes || 0)}));
  } else {
    if (!sha) {
      const branchInfo = await githubJson(`/repos/${repository}/branches/${encodeURIComponent(branch)}`, token);
      sha = branchInfo.commit?.sha;
    }
    if (!sha) throw new Error('Could not resolve the repository commit.');
    const tree = await githubJson(`/repos/${repository}/git/trees/${sha}?recursive=1`, token);
    rawPaths = tree.tree || [];
  }

  if (!sha) throw new Error('Could not resolve the repository commit.');
  const paths = rawPaths
    .filter((item) => item.type === 'blob' && isReviewable(item.path) && (!item.size || Number(item.size || 0) <= 180000))
    .sort((a,b) => Number(a.size || 0) - Number(b.size || 0))
    .slice(0, Math.max(10, Number(process.env.AGENT_MAX_FILES || 80)));

  const files = [];
  let totalBytes = 0;
  const maxBytes = Math.max(250000, Number(process.env.AGENT_MAX_SOURCE_BYTES || 1800000));
  for (const item of paths) {
    if (totalBytes >= maxBytes) break;
    const data = await githubJson(`/repos/${repository}/contents/${item.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`, token);
    if (!data?.content || data.encoding !== 'base64') continue;
    const content = Buffer.from(data.content.replace(/\n/g,''), 'base64').toString('utf8');
    if (/\u0000/.test(content)) continue;
    totalBytes += Buffer.byteLength(content);
    files.push({ path: item.path, content, sha: data.sha });
  }

  return { repository, branch, sha, files, meta };
}

function lineFor(content, index) {
  return content.slice(0, Math.max(0,index)).split('\n').length;
}

function addFinding(out, file, severity, category, title, details, recommendation, index = 0) {
  out.push({
    severity, category, title,
    file_path: file?.path || null,
    line_number: file ? lineFor(file.content, index) : null,
    details: String(details || '').slice(0, 4000),
    recommendation: String(recommendation || '').slice(0, 3000)
  });
}

function scanFile(file, findings, config) {
  const c = file.content;
  const p = file.path;

  const rules = [
    {
      re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"`][A-Za-z0-9_\-\/+=.]{12,}['"`]/ig,
      sev: 'high', cat: 'security', title: 'Possible hard-coded credential',
      rec: 'Move credentials to environment variables or a secret manager and rotate any exposed value.'
    },
    {
      re: /(?:eval\s*\(|new\s+Function\s*\()/g,
      sev: 'high', cat: 'security', title: 'Dynamic code execution detected',
      rec: 'Avoid eval/new Function. Use explicit parsing or a safe allow-listed dispatcher.'
    },
    {
      re: /child_process\.(?:exec|execSync)\s*\([^\n]*(?:req\.|request\.|params|query|body)/g,
      sev: 'critical', cat: 'security', title: 'Possible command injection path',
      rec: 'Do not pass request-controlled values to a shell. Use spawn/execFile with fixed arguments and strict validation.'
    },
    {
      re: /(?:shell_exec|system|exec|passthru)\s*\([^\n]*\$_(?:GET|POST|REQUEST)/g,
      sev: 'critical', cat: 'security', title: 'Possible PHP command injection',
      rec: 'Remove direct request data from shell execution and replace it with a strict allow-list.'
    },
    {
      re: /(?:query|execute)\s*\([^\n]*(?:\$_(?:GET|POST|REQUEST)|req\.(?:query|body|params))/g,
      sev: 'high', cat: 'security', title: 'Possible SQL injection',
      rec: 'Use prepared statements/parameterized queries and validate expected input types.'
    },
    {
      re: /innerHTML\s*=\s*(?:req\.|request\.|user|input|data\.)/g,
      sev: 'high', cat: 'security', title: 'Possible unsafe HTML injection',
      rec: 'Prefer textContent or sanitize untrusted HTML before insertion.'
    },
    {
      re: /cors\s*\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/gis,
      sev: 'medium', cat: 'security', title: 'Wildcard CORS configuration',
      rec: 'Restrict CORS to trusted application origins, especially when credentials or private APIs are involved.'
    },
    {
      re: /\b(?:TODO|FIXME|HACK)\b/g,
      sev: 'low', cat: 'maintainability', title: 'Unresolved maintenance marker',
      rec: 'Review this marker and convert real work into a tracked issue or remove stale comments.'
    }
  ];

  for (const rule of rules) {
    const securityRule = ['security','container'].includes(rule.cat);
    if (securityRule && !Number(config.enable_security || 0)) continue;
    if (!securityRule && !Number(config.enable_code_review || 0)) continue;
    rule.re.lastIndex = 0;
    let match;
    let count = 0;
    while ((match = rule.re.exec(c)) && count < 4) {
      addFinding(findings, file, rule.sev, rule.cat, rule.title, match[0].slice(0, 500), rule.rec, match.index);
      count += 1;
      if (rule.re.lastIndex === match.index) rule.re.lastIndex += 1;
    }
  }

  if (Number(config.enable_security || 0) && (p === '.env' || /(^|\/)\.env$/i.test(p))) {
    addFinding(findings, file, 'critical', 'security', 'Environment secrets file is tracked', p, 'Remove .env from Git history, add it to .gitignore, and rotate any credentials that may have been committed.');
  }

  if (Number(config.enable_security || 0) && /Dockerfile$/i.test(p) && !/^\s*USER\s+/mi.test(c)) {
    addFinding(findings, file, 'medium', 'container', 'Container has no explicit non-root USER', 'Dockerfile does not contain a USER directive.', 'Run the application as a dedicated non-root user where possible.');
  }

  if (Number(config.enable_code_review || 0) && /package\.json$/i.test(p)) {
    try {
      const pkg = JSON.parse(c);
      if (!pkg.scripts?.test && !pkg.scripts?.check) {
        addFinding(findings, file, 'medium', 'testing', 'No automated test/check script found', 'package.json has no test or check script.', 'Add a repeatable automated test or static-check command and run it in CI.');
      }
    } catch {}
  }
}

function makeSuggestions(files, findings) {
  const all = files.map((f) => `${f.path}\n${f.content.slice(0,12000)}`).join('\n').toLowerCase();
  const suggestions = [];
  const push = (title, type, priority, rationale, steps) => suggestions.push({title,test_type:type,priority,rationale,steps});

  if (/login|signin|sign in|auth|password/.test(all)) {
    push('Authentication success and failure matrix','browser','high','Authentication-related code was detected.',[
      'Open the login page','Verify valid credentials reach an authenticated page','Verify invalid credentials are rejected','Verify session/logout behavior'
    ]);
  }
  if (/role|permission|admin|authorize|middleware/.test(all)) {
    push('Role and permission boundary test','browser','high','Authorization/role code was detected.',[
      'Run the same protected workflow with an admin role','Repeat with a normal role','Confirm restricted actions are hidden and rejected server-side'
    ]);
  }
  if (/create|update|delete|insert into|method=['"]post|app\.post|router\.post/.test(all)) {
    push('CRUD validation and duplicate-data test','browser','high','Write operations or forms were detected.',[
      'Create a valid record','Try missing required fields','Try duplicate identifiers','Edit the record','Delete/cancel and confirm resulting state'
    ]);
  }
  if (/api\/|fetch\(|axios|app\.(get|post|put|delete)|router\.(get|post|put|delete)/.test(all)) {
    push('API status and malformed-input checks','api','high','API routes or HTTP client code were detected.',[
      'Call happy-path endpoint','Send missing/invalid parameters','Verify authorization','Verify 4xx/5xx bodies do not leak secrets'
    ]);
  }
  if (/upload|multipart|file\s*input|multer/.test(all)) {
    push('File upload boundary test','browser','medium','File upload handling was detected.',[
      'Upload an allowed file','Try an oversized file','Try a disallowed extension/MIME type','Verify stored filename/path is safe'
    ]);
  }
  push('Responsive smoke test','browser','medium','Every web project should preserve critical flows across common viewport sizes.',[
    'Run primary workflow on desktop','Repeat on tablet','Repeat on mobile','Check menus, dialogs, tables and forms for overflow'
  ]);
  push('Accessibility keyboard smoke test','browser','medium','Keyboard/focus failures are common regressions in interactive pages.',[
    'Navigate primary flow using keyboard only','Confirm visible focus','Confirm form labels and error messages','Run axe checks'
  ]);
  if (findings.some((f)=>['critical','high'].includes(f.severity))) {
    push('Security regression test for detected findings','security','high','The code scan found high-severity security patterns.',[
      'Reproduce each high-severity finding safely in staging','Apply the fix','Add a regression test','Re-run code and browser QA'
    ]);
  }
  return suggestions.slice(0, 20);
}

async function aiSummary(run, repoInfo, findings, suggestions) {
  const baseUrl = String(process.env.AI_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.AI_API_KEY || '';
  const model = process.env.AI_MODEL || '';
  if (!baseUrl || !apiKey || !model) return null;
  const payload = {
    repository: repoInfo.repository,
    branch: repoInfo.branch,
    commit: repoInfo.sha,
    findings: findings.slice(0,60).map(({severity,category,file_path,line_number,title,details})=>({severity,category,file_path,line_number,title,details})),
    test_suggestions: suggestions.slice(0,20).map(({title,test_type,priority,rationale})=>({title,test_type,priority,rationale}))
  };
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 30000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method:'POST',
      headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({
        model,
        temperature:0.1,
        messages:[{role:'user',content:`You are QADeck's software QA agent. Summarize this static code review for a developer. Prioritize concrete root causes and fixes. Do not invent findings. Keep it under 700 words. Data: ${JSON.stringify(payload)}`}]
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    return String(data?.choices?.[0]?.message?.content || '').slice(0,12000) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const claimAgentRun = db.transaction((workerId) => {
  const run = db.prepare("SELECT * FROM agent_runs WHERE status='queued' ORDER BY id ASC LIMIT 1").get();
  if (!run) return null;
  const changed = db.prepare("UPDATE agent_runs SET status='running',started_at=CURRENT_TIMESTAMP,heartbeat_at=CURRENT_TIMESTAMP,worker_id=?,error_message=NULL WHERE id=? AND status='queued'").run(workerId, run.id);
  if (!changed.changes) return null;
  const config = db.prepare('SELECT * FROM agent_configs WHERE project_id=?').get(run.project_id);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(run.project_id);
  if (!config || !project) {
    db.prepare("UPDATE agent_runs SET status='failed',completed_at=CURRENT_TIMESTAMP,error_message='Project or Agent configuration no longer exists.' WHERE id=?").run(run.id);
    return null;
  }
  return {...run, config, project};
});

function recoverStaleAgentRuns(staleMinutes = 5) {
  return db.prepare(`
    UPDATE agent_runs
    SET status='queued',worker_id=NULL,heartbeat_at=NULL,started_at=NULL,
        error_message=COALESCE(error_message,'Recovered after an interrupted Agent worker run.')
    WHERE status='running'
      AND (heartbeat_at IS NULL OR datetime(heartbeat_at) < datetime('now', ?))
  `).run(`-${Math.max(1, Number(staleMinutes))} minutes`).changes;
}

async function processNextAgentJob(workerId) {
  const run = claimAgentRun(workerId);
  if (!run) return false;
  try {
    db.prepare('DELETE FROM agent_findings WHERE agent_run_id=?').run(run.id);
    db.prepare('DELETE FROM agent_test_suggestions WHERE agent_run_id=?').run(run.id);
    const repo = await loadRepository(run.config, run);
    db.prepare('UPDATE agent_runs SET commit_sha=?,ref=?,heartbeat_at=CURRENT_TIMESTAMP WHERE id=?').run(repo.sha, repo.branch, run.id);

    const findings = [];
    if (Number(run.config.enable_code_review || 0) || Number(run.config.enable_security || 0)) {
      for (const file of repo.files) scanFile(file, findings, run.config);
    }

    const suggestions = Number(run.config.enable_test_suggestions || 0) ? makeSuggestions(repo.files, findings) : [];
    const insertFinding = db.prepare('INSERT INTO agent_findings (agent_run_id,severity,category,file_path,line_number,title,details,recommendation) VALUES (?,?,?,?,?,?,?,?)');
    const insertSuggestion = db.prepare('INSERT INTO agent_test_suggestions (agent_run_id,title,test_type,priority,rationale,steps_json) VALUES (?,?,?,?,?,?)');

    db.transaction(() => {
      findings.slice(0,250).forEach((f)=>insertFinding.run(run.id,f.severity,f.category,f.file_path,f.line_number,f.title,f.details,f.recommendation));
      suggestions.forEach((s)=>insertSuggestion.run(run.id,s.title,s.test_type,s.priority,s.rationale,JSON.stringify(s.steps || [])));
    })();

    const summary = await aiSummary(run, repo, findings, suggestions)
      || `Scanned ${repo.files.length} source/config files from ${repo.repository}@${repo.branch}. Found ${findings.length} review item(s) and generated ${suggestions.length} test suggestion(s).`;

    db.prepare(`
      UPDATE agent_runs
      SET status='completed',completed_at=CURRENT_TIMESTAMP,heartbeat_at=NULL,worker_id=NULL,
          files_scanned=?,findings_count=?,suggestions_count=?,summary=?,error_message=NULL
      WHERE id=?
    `).run(repo.files.length, findings.length, suggestions.length, summary, run.id);
  } catch (error) {
    db.prepare("UPDATE agent_runs SET status='failed',completed_at=CURRENT_TIMESTAMP,heartbeat_at=NULL,worker_id=NULL,error_message=? WHERE id=?")
      .run(String(error.message || error).slice(0,4000), run.id);
  }
  return true;
}

module.exports = {
  ensureAgentSchema,
  normalizeRepository,
  processNextAgentJob,
  recoverStaleAgentRuns
};
