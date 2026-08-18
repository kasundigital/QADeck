const os = require('os');
const crypto = require('crypto');
const db = require('./db');
const { runProject } = require('./runner');
const { runScenario } = require('./scenario-runner');

const pollMs = Math.max(500, Number(process.env.WORKER_POLL_MS || 1500));
const staleMinutes = Math.max(1, Number(process.env.WORKER_STALE_MINUTES || 2));
const scheduleCheckMs = Math.max(10000, Number(process.env.SCHEDULE_CHECK_MS || 30000));
const workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;
let lastScheduleCheck = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recoverStaleRuns() {
  const result = db.prepare(`
    UPDATE test_runs
    SET status='queued', worker_id=NULL, heartbeat_at=NULL, current_url=NULL,
        error_message=CASE
          WHEN error_message IS NULL OR error_message='' THEN 'Recovered after an interrupted worker run.'
          ELSE error_message
        END
    WHERE status='running'
      AND (heartbeat_at IS NULL OR datetime(heartbeat_at) < datetime('now', ?))
  `).run(`-${staleMinutes} minutes`);

  if (result.changes) console.log(`[QADeck worker] Re-queued ${result.changes} stale run(s).`);
}

const enqueueDueSchedules = db.transaction(() => {
  const due = db.prepare(`
    SELECT p.id, p.name
    FROM projects p
    WHERE p.schedule_enabled=1
      AND p.schedule_interval_minutes >= 1
      AND NOT EXISTS (
        SELECT 1 FROM test_runs r
        WHERE r.project_id=p.id AND r.status IN ('queued','running')
      )
      AND (
        p.schedule_last_queued_at IS NULL
        OR datetime(p.schedule_last_queued_at, '+' || p.schedule_interval_minutes || ' minutes') <= CURRENT_TIMESTAMP
      )
  `).all();

  const insertRun = db.prepare(`
    INSERT INTO test_runs (project_id, status, queued_at, run_type)
    VALUES (?, 'queued', CURRENT_TIMESTAMP, 'crawl')
  `);
  const markProject = db.prepare('UPDATE projects SET schedule_last_queued_at=CURRENT_TIMESTAMP WHERE id=?');

  for (const project of due) {
    insertRun.run(project.id);
    markProject.run(project.id);
    console.log(`[QADeck scheduler] Queued scheduled crawl for ${project.name}.`);
  }
});

const claimNextRun = db.transaction(() => {
  const run = db.prepare(`
    SELECT id, project_id, run_type, scenario_id, started_at
    FROM test_runs
    WHERE status='queued'
    ORDER BY id ASC
    LIMIT 1
  `).get();

  if (!run) return null;

  if (run.started_at) {
    db.prepare('DELETE FROM scenario_step_results WHERE run_id=?').run(run.id);
    db.prepare('DELETE FROM test_issues WHERE run_id=?').run(run.id);
    db.prepare('DELETE FROM test_pages WHERE run_id=?').run(run.id);
    db.prepare(`
      UPDATE test_runs
      SET started_at=NULL, completed_at=NULL, pages_scanned=0, issues_count=0, clean_pages=0,
          trace_path=NULL, video_path=NULL, error_message=NULL
      WHERE id=?
    `).run(run.id);
  }

  const claimed = db.prepare(`
    UPDATE test_runs
    SET status='running',
        started_at=CURRENT_TIMESTAMP,
        heartbeat_at=CURRENT_TIMESTAMP,
        worker_id=?,
        current_url=NULL,
        error_message=NULL
    WHERE id=? AND status='queued'
  `).run(workerId, run.id);

  if (!claimed.changes) return null;

  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(run.project_id);
  if (!project) {
    db.prepare(`
      UPDATE test_runs
      SET status='failed', completed_at=CURRENT_TIMESTAMP,
          error_message='Project no longer exists.', worker_id=NULL, heartbeat_at=NULL
      WHERE id=?
    `).run(run.id);
    return null;
  }

  return { runId: run.id, project, runType: run.run_type || 'crawl', scenarioId: run.scenario_id || null };
});

async function loop() {
  recoverStaleRuns();
  console.log(`[QADeck worker] Started as ${workerId}. Polling every ${pollMs} ms.`);

  while (!stopping) {
    try {
      if (Date.now() - lastScheduleCheck >= scheduleCheckMs) {
        enqueueDueSchedules();
        lastScheduleCheck = Date.now();
      }
    } catch (error) {
      console.error('[QADeck scheduler] Schedule check failed:', error);
    }

    let job = null;
    try {
      job = claimNextRun();
    } catch (error) {
      console.error('[QADeck worker] Could not claim job:', error);
      await sleep(pollMs);
      continue;
    }

    if (!job) {
      await sleep(pollMs);
      continue;
    }

    console.log(`[QADeck worker] Running ${job.runType} job #${job.runId} for ${job.project.name}.`);
    try {
      if (job.runType === 'scenario') {
        await runScenario(job.runId, job.project, job.scenarioId, { workerId });
      } else {
        await runProject(job.runId, job.project, { workerId });
      }
    } catch (error) {
      console.error(`[QADeck worker] Run #${job.runId} crashed:`, error);
      db.prepare(`
        UPDATE test_runs
        SET status='failed', completed_at=CURRENT_TIMESTAMP,
            error_message=?, worker_id=NULL, heartbeat_at=NULL, current_url=NULL
        WHERE id=?
      `).run(error.message || String(error), job.runId);
    }
  }

  console.log('[QADeck worker] Stopped.');
}

function stop() {
  stopping = true;
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

loop().catch((error) => {
  console.error('[QADeck worker] Fatal worker error:', error);
  process.exitCode = 1;
});
