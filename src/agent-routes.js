const db = require('./db');
const { encrypt } = require('./crypto');
const { ensureAgentSchema, normalizeRepository, createGithubIssueFromRun } = require('./agent-service');

ensureAgentSchema();

function parseToggle(body, name, fallback = 1) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, name)) return fallback;
  const value = Array.isArray(body[name]) ? body[name][body[name].length - 1] : body[name];
  return String(value) === '1' ? 1 : 0;
}

function configFor(projectId) {
  return db.prepare('SELECT * FROM agent_configs WHERE project_id=?').get(projectId) || {
    project_id: Number(projectId),
    repository: '',
    branch: '',
    github_token_enc: null,
    enable_code_review: 1,
    enable_security: 1,
    enable_test_suggestions: 1
  };
}

function installAgentRoutes(app) {
  if (app.__qadeckAgentRoutesInstalled) return;
  app.__qadeckAgentRoutesInstalled = true;

  app.get('/agents', (req, res) => {
    const projects = db.prepare(`
      SELECT p.id,p.name,p.base_url,c.repository,c.branch,
        (SELECT id FROM agent_runs ar WHERE ar.project_id=p.id ORDER BY ar.id DESC LIMIT 1) last_agent_run_id,
        (SELECT status FROM agent_runs ar WHERE ar.project_id=p.id ORDER BY ar.id DESC LIMIT 1) last_agent_status,
        (SELECT findings_count FROM agent_runs ar WHERE ar.project_id=p.id ORDER BY ar.id DESC LIMIT 1) last_findings,
        (SELECT completed_at FROM agent_runs ar WHERE ar.project_id=p.id ORDER BY ar.id DESC LIMIT 1) last_agent_completed
      FROM projects p
      LEFT JOIN agent_configs c ON c.project_id=p.id
      ORDER BY p.id DESC
    `).all();
    const totals = {
      configured: db.prepare("SELECT COUNT(*) c FROM agent_configs WHERE repository IS NOT NULL AND repository<>''").get().c,
      runs: db.prepare('SELECT COUNT(*) c FROM agent_runs').get().c,
      findings: db.prepare('SELECT COALESCE(SUM(findings_count),0) c FROM agent_runs').get().c,
      running: db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE status IN ('queued','running')").get().c
    };
    res.render('agents', { projects, totals, email:req.session?.email || '' });
  });

  app.get('/projects/:id/agent', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).send('Project not found');
    const config = configFor(project.id);
    const runs = db.prepare('SELECT * FROM agent_runs WHERE project_id=? ORDER BY id DESC LIMIT 30').all(project.id);
    res.render('agent-project', { project, config, runs, saved:req.query.saved === '1', error:null });
  });

  app.post('/projects/:id/agent', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).send('Project not found');
    const repository = normalizeRepository(req.body.repository);
    const config = configFor(project.id);
    if (!repository) {
      return res.status(400).render('agent-project', {
        project,
        config:{...config,...req.body},
        runs:db.prepare('SELECT * FROM agent_runs WHERE project_id=? ORDER BY id DESC LIMIT 30').all(project.id),
        saved:false,
        error:'Enter a valid GitHub repository such as owner/repo or a GitHub repository URL.'
      });
    }
    const branch = String(req.body.branch || '').trim();
    let tokenEnc = config.github_token_enc;
    if (req.body.github_token) tokenEnc = encrypt(String(req.body.github_token).trim());
    if (req.body.clear_github_token === '1') tokenEnc = null;

    db.prepare(`
      INSERT INTO agent_configs (project_id,repository,branch,github_token_enc,enable_code_review,enable_security,enable_test_suggestions,updated_at)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(project_id) DO UPDATE SET
        repository=excluded.repository,
        branch=excluded.branch,
        github_token_enc=excluded.github_token_enc,
        enable_code_review=excluded.enable_code_review,
        enable_security=excluded.enable_security,
        enable_test_suggestions=excluded.enable_test_suggestions,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      project.id, repository, branch || null, tokenEnc,
      parseToggle(req.body,'enable_code_review'),
      parseToggle(req.body,'enable_security'),
      parseToggle(req.body,'enable_test_suggestions')
    );
    res.redirect(`/projects/${project.id}/agent?saved=1`);
  });

  app.post('/projects/:id/agent/run', (req, res) => {
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id);
    const config = db.prepare('SELECT * FROM agent_configs WHERE project_id=?').get(req.params.id);
    if (!project) return res.status(404).send('Project not found');
    if (!config?.repository) return res.status(400).send('Configure the GitHub Agent for this project first.');

    const active = db.prepare("SELECT id FROM agent_runs WHERE project_id=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(project.id);
    if (active) return res.redirect(`/agent-runs/${active.id}`);

    const result = db.prepare("INSERT INTO agent_runs (project_id,status,trigger_type,ref) VALUES (?,'queued','manual',?)")
      .run(project.id, String(req.body.ref || config.branch || '').trim() || null);
    res.redirect(`/agent-runs/${result.lastInsertRowid}`);
  });

  app.get('/agent-runs/:id', (req, res) => {
    const run = db.prepare(`
      SELECT ar.*,p.name project_name,p.base_url,c.repository,c.branch
      FROM agent_runs ar
      JOIN projects p ON p.id=ar.project_id
      LEFT JOIN agent_configs c ON c.project_id=ar.project_id
      WHERE ar.id=?
    `).get(req.params.id);
    if (!run) return res.status(404).send('Agent run not found');
    const findings = db.prepare(`
      SELECT * FROM agent_findings WHERE agent_run_id=?
      ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,id
    `).all(run.id);
    const suggestions = db.prepare('SELECT * FROM agent_test_suggestions WHERE agent_run_id=? ORDER BY CASE priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END,id').all(run.id)
      .map((s)=>{ try{s.steps=JSON.parse(s.steps_json || '[]');}catch{s.steps=[];} return s; });
    res.render('agent-run', { run, findings, suggestions });
  });

  app.get('/api/agent-runs/:id', (req, res) => {
    const run = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(req.params.id);
    if (!run) return res.status(404).json({error:'Agent run not found'});
    const findings = db.prepare('SELECT severity,category,file_path,line_number,title,details,recommendation FROM agent_findings WHERE agent_run_id=? ORDER BY id').all(run.id);
    const suggestions = db.prepare('SELECT title,test_type,priority,rationale,steps_json FROM agent_test_suggestions WHERE agent_run_id=? ORDER BY id').all(run.id);
    res.json({run,findings,suggestions});
  });

  app.post('/agent-runs/:id/github-issue', async (req, res) => {
    try {
      const issue = await createGithubIssueFromRun(Number(req.params.id));
      if (issue && issue.html_url) return res.redirect(issue.html_url);
      return res.redirect('/agent-runs/' + req.params.id);
    } catch (error) {
      return res.status(400).send('Could not create GitHub issue: ' + (error.message || String(error)));
    }
  });

  app.post('/agent-runs/:id/delete', (req, res) => {
    const run = db.prepare('SELECT project_id,status FROM agent_runs WHERE id=?').get(req.params.id);
    if (!run) return res.status(404).send('Agent run not found');
    if (run.status === 'running') return res.status(409).send('Cannot delete a running Agent analysis.');
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(req.params.id);
    res.redirect(`/projects/${run.project_id}/agent`);
  });
}

module.exports = { installAgentRoutes };
