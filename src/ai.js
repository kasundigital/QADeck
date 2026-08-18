const db = require('./db');

async function summarizeRun(runId) {
  const baseUrl = String(process.env.AI_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.AI_API_KEY || '';
  const model = process.env.AI_MODEL || '';
  if (!baseUrl || !apiKey || !model) return null;

  const run = db.prepare(`SELECT r.*, p.name project_name FROM test_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?`).get(runId);
  if (!run) return null;
  const issues = db.prepare('SELECT severity, category, message, details FROM test_issues WHERE run_id=? ORDER BY id LIMIT 60').all(runId);
  const prompt = `Summarize this QA test run for a developer. Be concise. Group likely root causes, highest priority fixes, and any flaky indicators. Project: ${run.project_name}. Status: ${run.status}. Views: ${run.pages_scanned}. Issues: ${run.issues_count}. Findings: ${JSON.stringify(issues)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`AI API HTTP ${response.status}`);
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (text) db.prepare('UPDATE test_runs SET ai_summary=? WHERE id=?').run(String(text).slice(0, 12000), runId);
    return text || null;
  } catch (error) {
    console.warn('[QADeck AI] Summary failed:', error.message);
    return null;
  } finally { clearTimeout(timer); }
}

module.exports = { summarizeRun };
