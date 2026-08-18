const nodemailer = require('nodemailer');
const db = require('./db');
const { decrypt } = require('./crypto');

function log(runId, channel, status, message = '') {
  try { db.prepare('INSERT INTO notification_logs (run_id, channel, status, message) VALUES (?, ?, ?, ?)').run(runId, channel, status, String(message || '').slice(0, 2000)); } catch {}
}
async function postJson(url, body) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try { const response = await fetch(url, { method:'POST', headers:{'content-type':'application/json','user-agent':'QADeck/0.5 Notifier'}, body:JSON.stringify(body), signal:controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); }
  finally { clearTimeout(timer); }
}
function runSummary(run, project) {
  const ok = run.status === 'completed' && Number(run.issues_count || 0) === 0;
  return { title:`QADeck ${ok ? 'PASS' : 'ISSUES'} · ${project.name}`, text:`${project.name} run #${run.id}: ${run.status}, ${run.pages_scanned || 0} views, ${run.issues_count || 0} issues.`, ok };
}
async function sendWebhook(run, project, summary) {
  if (!project.webhook_url_enc) return; const url = decrypt(project.webhook_url_enc); if (!url) return;
  try { if (/discord(?:app)?\.com\/api\/webhooks/i.test(url)) await postJson(url,{content:`**${summary.title}**\n${summary.text}`}); else await postJson(url,{event:'qadeck.run.completed',project:{id:project.id,name:project.name},run,summary}); log(run.id,'webhook','sent'); }
  catch (error) { log(run.id,'webhook','failed',error.message); }
}
async function sendTelegram(run, project, summary) {
  const token=process.env.TELEGRAM_BOT_TOKEN, chatId=project.telegram_chat_id; if(!token||!chatId)return;
  try { await postJson(`https://api.telegram.org/bot${token}/sendMessage`,{chat_id:chatId,text:`${summary.title}\n${summary.text}`,disable_web_page_preview:true}); log(run.id,'telegram','sent'); }
  catch(error){ log(run.id,'telegram','failed',error.message); }
}
async function sendEmail(run, project, summary) {
  if(!project.notify_email||!process.env.SMTP_HOST)return;
  const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false')==='true',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS||''}:undefined});
  try { await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER||'qadeck@localhost',to:project.notify_email,subject:summary.title,text:`${summary.text}\n\nQADeck run #${run.id}`}); log(run.id,'email','sent'); }
  catch(error){ log(run.id,'email','failed',error.message); }
}
async function notifyRun(runId) {
  const run=db.prepare('SELECT * FROM test_runs WHERE id=?').get(runId); if(!run)return; const project=db.prepare('SELECT * FROM projects WHERE id=?').get(run.project_id); if(!project)return;
  const summary=runSummary(run,project), shouldNotify=summary.ok?Number(project.notify_on_success||0)===1:Number(project.notify_on_failure??1)===1; if(!shouldNotify)return;
  await Promise.allSettled([sendWebhook(run,project,summary),sendTelegram(run,project,summary),sendEmail(run,project,summary)]);
}
module.exports={notifyRun};
