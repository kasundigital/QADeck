const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const db = require('./db');
const { decrypt } = require('./crypto');

const maxPagesPerViewport = Math.max(1, Number(process.env.MAX_PAGES_PER_RUN || 20));
const pageTimeout = Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 20000));
const visualThresholdPct = Math.max(0, Number(process.env.VISUAL_DIFF_THRESHOLD_PCT || 0.25));
const artifactRoot = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');
const axePath = require.resolve('axe-core/axe.min.js');

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 }, laptop: { width: 1366, height: 768 }, tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 }, 'small-mobile': { width: 360, height: 800 }
};
const dangerousPath = /(logout|log-out|signout|sign-out|delete|remove|destroy|terminate|drop|purge|unsubscribe)/i;
const enabled = (value) => Number(value) === 1 || value === true;

function cleanUrl(raw, base) {
  try { const url = new URL(raw, base); url.hash = ''; return ['http:','https:'].includes(url.protocol) ? url.toString() : null; } catch { return null; }
}
function severityForStatus(status) { return status >= 500 ? 'critical' : status >= 400 ? 'high' : 'medium'; }
function accessibilitySeverity(impact) { return impact === 'critical' || impact === 'serious' ? 'high' : impact === 'moderate' ? 'medium' : 'low'; }
function parseViewports(project) {
  try { const parsed = JSON.parse(project.viewport_profiles || '[]'); const valid = Array.isArray(parsed) ? parsed.filter((n) => VIEWPORTS[n]) : []; return valid.length ? valid : ['desktop']; } catch { return ['desktop']; }
}
function parseExtraLoginFields(project) {
  if (!project.extra_login_fields_enc) return [];
  try { const parsed = JSON.parse(decrypt(project.extra_login_fields_enc)); return Array.isArray(parsed) ? parsed.slice(0,20) : []; } catch { return []; }
}
function cssQuoted(value) { return String(value || '').replace(/\\/g,'\\\\').replace(/"/g,'\\"'); }
async function visibleLocator(locator) { try { if (!(await locator.count())) return null; const first = locator.first(); return await first.isVisible({ timeout: 500 }) ? first : null; } catch { return null; } }
async function firstVisible(page, selectors) { for (const selector of selectors) { const locator = await visibleLocator(page.locator(selector)); if (locator) return locator; } return null; }
async function locateCustomField(page, field) {
  if (field.selector) { const locator = await visibleLocator(page.locator(field.selector)); if (locator) return locator; }
  if (!field.name) return null;
  try { const byLabel = await visibleLocator(page.getByLabel(field.name, { exact: false })); if (byLabel) return byLabel; } catch {}
  const name = cssQuoted(field.name);
  return firstVisible(page,[`[name="${name}"]`,`input[placeholder*="${name}" i]`,`select[placeholder*="${name}" i]`,`input[aria-label*="${name}" i]`,`select[aria-label*="${name}" i]`]);
}
async function fillCustomField(page, field, addLooseIssue, viewportName) {
  const locator = await locateCustomField(page, field);
  if (!locator) { addLooseIssue('high','authentication',`Could not find extra login field: ${field.name || field.selector}`,`Viewport: ${viewportName}`); return; }
  try { const tag = await locator.evaluate((e) => e.tagName.toLowerCase()); if (field.type === 'select' || tag === 'select') await locator.selectOption({label:String(field.value||'')}).catch(() => locator.selectOption(String(field.value||''))); else await locator.fill(String(field.value||'')); }
  catch (error) { addLooseIssue('high','authentication',`Could not fill extra login field: ${field.name || field.selector}`,`${viewportName}: ${error.message}`); }
}
async function findUsernameField(page) {
  const semantic = await firstVisible(page,['input[type="email"]','input[name*="email" i]','input[name*="username" i]','input[name*="user_name" i]','input[name*="user" i]','input[name*="login" i]','input[autocomplete="username"]']);
  if (semantic) return semantic;
  try { const textInputs = page.locator('input[type="text"]:visible'); const count = await textInputs.count(); if (count) return textInputs.nth(count-1); } catch {}
  return null;
}
async function attemptLogin(page, project, addLooseIssue, viewportName) {
  if (!project.login_url) return;
  if (!project.username || !project.password_enc) { addLooseIssue('medium','authentication','Login URL is configured but username/password are incomplete',`Viewport: ${viewportName}`); return; }
  const loginUrl = cleanUrl(project.login_url, project.base_url);
  if (!loginUrl) { addLooseIssue('high','authentication','Invalid login URL',project.login_url || ''); return; }
  try {
    await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:pageTimeout});
    for (const field of parseExtraLoginFields(project)) await fillCustomField(page,field,addLooseIssue,viewportName);
    const userInput = await findUsernameField(page);
    const passInput = await firstVisible(page,['input[type="password"]','input[autocomplete="current-password"]']);
    if (!userInput || !passInput) { addLooseIssue('high','authentication','QADeck could not identify the username/password fields',`${loginUrl} · ${viewportName}`); return; }
    await userInput.fill(project.username); await passInput.fill(decrypt(project.password_enc));
    const submit = await firstVisible(page,['button[type="submit"]','input[type="submit"]','button:has-text("Login")','button:has-text("Log in")','button:has-text("Sign in")']);
    if (!submit) { addLooseIssue('high','authentication','QADeck could not identify the login submit button',`${loginUrl} · ${viewportName}`); return; }
    await submit.click(); await page.waitForLoadState('domcontentloaded',{timeout:pageTimeout}).catch(()=>{}); await page.waitForTimeout(700);
    if (await page.locator('input[type="password"]:visible').count()) addLooseIssue('high','authentication','Login may have failed; password field is still visible',`${page.url()} · ${viewportName}`);
  } catch (error) { addLooseIssue('high','authentication','Login flow failed',`${viewportName}: ${error.message}`); }
}
function updateProgress(runId,pagesScanned,totalIssues,cleanPages,currentUrl=null) { db.prepare(`UPDATE test_runs SET pages_scanned=?,issues_count=?,clean_pages=?,current_url=?,heartbeat_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'`).run(pagesScanned,totalIssues,cleanPages,currentUrl,runId); }
function baselineInfo(projectId,viewportName,url) { const hash=crypto.createHash('sha1').update(url).digest('hex').slice(0,20); const relative=path.join('baselines',String(projectId),viewportName,`${hash}.png`); return {absolute:path.join(artifactRoot,relative),web:`/artifacts/${relative.split(path.sep).join('/')}`}; }
function compareVisual(currentPath,baselinePath,diffPath) {
  const current=PNG.sync.read(fs.readFileSync(currentPath)), baseline=PNG.sync.read(fs.readFileSync(baselinePath));
  if (current.width!==baseline.width || current.height!==baseline.height) return {changedPct:100,dimensionChanged:true,diffWritten:false};
  const diff=new PNG({width:current.width,height:current.height});
  const changedPixels=pixelmatch(baseline.data,current.data,diff.data,current.width,current.height,{threshold:0.1,includeAA:false});
  const changedPct=(changedPixels/(current.width*current.height))*100; if (changedPixels>0) fs.writeFileSync(diffPath,PNG.sync.write(diff));
  return {changedPct,dimensionChanged:false,diffWritten:changedPixels>0};
}
async function runAccessibility(page,addPageIssue) {
  try { await page.addScriptTag({path:axePath}); const result=await page.evaluate(async()=>window.axe.run(document,{resultTypes:['violations'],rules:{region:{enabled:false}}}));
    for (const violation of result.violations.slice(0,30)) { const targets=violation.nodes.slice(0,4).flatMap((n)=>n.target||[]).join(', '); addPageIssue(accessibilitySeverity(violation.impact),'accessibility',violation.help||violation.id,`${violation.description||''}${targets?`\nElements: ${targets}`:''}`); }
    return result.violations.length;
  } catch (error) { addPageIssue('low','accessibility','Accessibility scan could not complete',error.message); return 0; }
}

async function collectPerformance(page, project, addPageIssue) {
  if (!enabled(project.enable_performance)) return { json: null, score: null };
  try {
    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const p = window.__qadeckVitals || {};
      return {
        ttfb: nav ? Math.round(nav.responseStart) : null,
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav ? Math.round(nav.loadEventEnd || performance.now()) : Math.round(performance.now()),
        transferSize: nav ? nav.transferSize : null,
        lcp: p.lcp ? Math.round(p.lcp) : null,
        cls: typeof p.cls === 'number' ? Number(p.cls.toFixed(4)) : null
      };
    });
    const budget = Math.max(500, Number(project.performance_budget_ms || 3000));
    const primary = metrics.lcp || metrics.load || 0;
    let score = 100;
    if (primary > budget) { score = Math.max(0, Math.round(100 - ((primary-budget)/budget)*60)); addPageIssue(primary > budget*2 ? 'high' : 'medium','performance',`Performance budget exceeded`,`Primary load metric ${primary} ms exceeds ${budget} ms budget.`); }
    if (metrics.cls !== null && metrics.cls > 0.25) { score = Math.max(0,score-20); addPageIssue('medium','performance',`High layout shift (CLS ${metrics.cls})`,'CLS above 0.25 can cause visible UI movement.'); }
    return { json: JSON.stringify(metrics), score };
  } catch (error) { addPageIssue('low','performance','Performance metrics unavailable',error.message); return { json:null, score:null }; }
}

function attachPageDiagnostics(page,addPageIssue) {
  const onConsole=(msg)=>{if(msg.type()==='error')addPageIssue('medium','console','Browser console error',msg.text());};
  const onPageError=(error)=>addPageIssue('high','javascript','Uncaught JavaScript error',error.message);
  const onRequestFailed=(request)=>addPageIssue('medium','network','Network request failed',`${request.method()} ${request.url()} — ${request.failure()?.errorText||'unknown error'}`);
  const onResponse=(response)=>{if(response.status()>=400)addPageIssue(severityForStatus(response.status()),'http',`HTTP ${response.status()} response`,response.url());};
  page.on('console',onConsole); page.on('pageerror',onPageError); page.on('requestfailed',onRequestFailed); page.on('response',onResponse);
  return ()=>{page.off('console',onConsole);page.off('pageerror',onPageError);page.off('requestfailed',onRequestFailed);page.off('response',onResponse);};
}

async function runProject(runId,project,options={}) {
  const workerId=options.workerId||null, runDir=path.join(artifactRoot,String(runId)), videoDir=path.join(runDir,'videos');
  fs.mkdirSync(runDir,{recursive:true}); if(enabled(project.enable_video))fs.mkdirSync(videoDir,{recursive:true});
  db.prepare(`UPDATE test_runs SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP),heartbeat_at=CURRENT_TIMESTAMP,worker_id=COALESCE(worker_id,?) WHERE id=?`).run(workerId,runId);
  let browser,totalIssues=0,pagesScanned=0,cleanPages=0,firstTracePath=null,firstVideoPath=null; const looseIssues=[];
  const addLooseIssue=(severity,category,message,details='')=>looseIssues.push({severity,category,message,details:String(details||'')});
  try {
    browser=await chromium.launch({headless:true});
    for(const viewportName of parseViewports(project)) {
      const viewport=VIEWPORTS[viewportName]||VIEWPORTS.desktop; let context,page,traceStarted=false,videoHandle=null;
      try {
        context=await browser.newContext({viewport,bypassCSP:true,userAgent:`QADeck/0.5 Playwright QA Runner (${viewportName})`,recordVideo:enabled(project.enable_video)?{dir:videoDir,size:viewport}:undefined});
        await context.addInitScript(() => {
          window.__qadeckVitals={lcp:null,cls:0};
          try { new PerformanceObserver((list)=>{const e=list.getEntries(); const last=e[e.length-1]; if(last)window.__qadeckVitals.lcp=last.startTime;}).observe({type:'largest-contentful-paint',buffered:true}); } catch {}
          try { new PerformanceObserver((list)=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.__qadeckVitals.cls+=e.value;}).observe({type:'layout-shift',buffered:true}); } catch {}
        });
        if(enabled(project.enable_trace)){await context.tracing.start({screenshots:true,snapshots:true,sources:false});traceStarted=true;}
        page=await context.newPage(); videoHandle=page.video(); page.setDefaultTimeout(pageTimeout);
        db.prepare('UPDATE test_runs SET current_url=?,heartbeat_at=CURRENT_TIMESTAMP WHERE id=?').run(project.login_url||project.base_url,runId);
        await attemptLogin(page,project,addLooseIssue,viewportName);
        const startUrl=cleanUrl(project.base_url,project.base_url); if(!startUrl)throw new Error('Invalid project Base URL');
        const origin=new URL(startUrl).origin, queue=[startUrl], seen=new Set(); let profilePages=0;
        while(queue.length && profilePages<maxPagesPerViewport){
          const url=queue.shift(); if(!url||seen.has(url))continue; seen.add(url); if(dangerousPath.test(new URL(url).pathname))continue;
          db.prepare('UPDATE test_runs SET current_url=?,heartbeat_at=CURRENT_TIMESTAMP WHERE id=?').run(`${viewportName}: ${url}`,runId);
          const pageIssues=[],issueKeys=new Set(); const addPageIssue=(severity,category,message,details='')=>{const key=`${category}|${message}|${details}`;if(issueKeys.has(key))return;issueKeys.add(key);pageIssues.push({severity,category,message,details:String(details||'')});};
          const detachDiagnostics=attachPageDiagnostics(page,addPageIssue);
          let mainStatus=null; const started=Date.now();
          try { const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:pageTimeout}); mainStatus=response?response.status():null; await page.waitForTimeout(500); } catch(error){addPageIssue('critical','navigation','Page navigation failed',error.message);}
          const durationMs=Date.now()-started,title=await page.title().catch(()=>''),screenshotFile=`${viewportName}-page-${profilePages+1}.png`,screenshotAbsolute=path.join(runDir,screenshotFile),screenshotWeb=`/artifacts/${runId}/${screenshotFile}`;
          try{await page.screenshot({path:screenshotAbsolute,fullPage:true});}catch(error){addPageIssue('low','screenshot','Could not capture screenshot',error.message);}
          try{const brokenImages=await page.locator('img').evaluateAll((imgs)=>imgs.filter((img)=>img.complete&&img.naturalWidth===0).map((img)=>img.currentSrc||img.src||img.alt||'unknown image').slice(0,10));for(const image of brokenImages)addPageIssue('medium','asset','Broken image detected',image);}catch{}
          try{const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>window.innerWidth+4,viewportWidth:window.innerWidth,documentWidth:document.documentElement.scrollWidth}));if(layout.overflow)addPageIssue('medium','responsive',`Horizontal overflow on ${viewportName}`,`Viewport ${layout.viewportWidth}px, document ${layout.documentWidth}px.`);}catch{}
          let accessibilityCount=0;if(enabled(project.enable_accessibility))accessibilityCount=await runAccessibility(page,addPageIssue);
          const perf=await collectPerformance(page,project,addPageIssue);
          let baselinePath=null,diffPath=null,visualChangePct=null;
          if(enabled(project.enable_visual)&&fs.existsSync(screenshotAbsolute)){const baseline=baselineInfo(project.id,viewportName,url);baselinePath=baseline.web;fs.mkdirSync(path.dirname(baseline.absolute),{recursive:true});if(!fs.existsSync(baseline.absolute)){fs.copyFileSync(screenshotAbsolute,baseline.absolute);visualChangePct=0;}else{const diffFile=`${viewportName}-diff-${profilePages+1}.png`,diffAbsolute=path.join(runDir,diffFile),visual=compareVisual(screenshotAbsolute,baseline.absolute,diffAbsolute);visualChangePct=Number(visual.changedPct.toFixed(4));if(visual.diffWritten)diffPath=`/artifacts/${runId}/${diffFile}`;if(visual.dimensionChanged)addPageIssue('high','visual',`Visual dimensions changed on ${viewportName}`,'Current screenshot dimensions do not match the approved baseline.');else if(visual.changedPct>visualThresholdPct)addPageIssue('medium','visual',`Visual regression detected on ${viewportName}`,`${visual.changedPct.toFixed(2)}% of pixels changed from the approved baseline.`);}}
          const pageResult=db.prepare(`INSERT INTO test_pages (run_id,url,title,status_code,screenshot_path,duration_ms,viewport,baseline_path,diff_path,visual_change_pct,accessibility_count,performance_json,performance_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId,url,title,mainStatus,screenshotWeb,durationMs,viewportName,baselinePath,diffPath,visualChangePct,accessibilityCount,perf.json,perf.score);
          const pageId=Number(pageResult.lastInsertRowid),issueStmt=db.prepare(`INSERT INTO test_issues (run_id,page_id,severity,category,message,details) VALUES (?,?,?,?,?,?)`);for(const issue of pageIssues)issueStmt.run(runId,pageId,issue.severity,issue.category,issue.message,issue.details);
          totalIssues+=pageIssues.length;pagesScanned++;profilePages++;if(pageIssues.length===0)cleanPages++;updateProgress(runId,pagesScanned,totalIssues,cleanPages,`${viewportName}: ${url}`);
          try{const links=await page.locator('a[href]').evaluateAll((anchors)=>anchors.map((a)=>a.href));for(const raw of links){const discovered=cleanUrl(raw,url);if(!discovered)continue;const parsed=new URL(discovered);if(parsed.origin!==origin||dangerousPath.test(parsed.pathname))continue;if(!seen.has(discovered)&&!queue.includes(discovered))queue.push(discovered);}}catch{}
          detachDiagnostics();
        }
      }catch(error){addLooseIssue('high','runner',`Viewport run failed: ${viewportName}`,error.message);}finally{
        if(context&&traceStarted){const traceFile=`trace-${viewportName}.zip`,traceAbsolute=path.join(runDir,traceFile);try{await context.tracing.stop({path:traceAbsolute});if(!firstTracePath)firstTracePath=`/artifacts/${runId}/${traceFile}`;}catch{}}
        if(context)await context.close().catch(()=>{});if(videoHandle){try{const videoAbsolute=await videoHandle.path();if(videoAbsolute&&fs.existsSync(videoAbsolute)&&!firstVideoPath)firstVideoPath=`/artifacts/${path.relative(artifactRoot,videoAbsolute).split(path.sep).join('/')}`;}catch{}}
      }
    }
    const looseStmt=db.prepare(`INSERT INTO test_issues (run_id,page_id,severity,category,message,details) VALUES (?,NULL,?,?,?,?)`);for(const issue of looseIssues)looseStmt.run(runId,issue.severity,issue.category,issue.message,issue.details);totalIssues+=looseIssues.length;updateProgress(runId,pagesScanned,totalIssues,cleanPages,null);
    db.prepare(`UPDATE test_runs SET status='completed',completed_at=CURRENT_TIMESTAMP,pages_scanned=?,issues_count=?,clean_pages=?,trace_path=?,video_path=?,current_url=NULL,heartbeat_at=NULL,worker_id=NULL WHERE id=?`).run(pagesScanned,totalIssues,cleanPages,firstTracePath,firstVideoPath,runId);
  }catch(error){db.prepare(`UPDATE test_runs SET status='failed',completed_at=CURRENT_TIMESTAMP,pages_scanned=?,issues_count=?,clean_pages=?,error_message=?,trace_path=?,video_path=?,current_url=NULL,heartbeat_at=NULL,worker_id=NULL WHERE id=?`).run(pagesScanned,totalIssues,cleanPages,error.message,firstTracePath,firstVideoPath,runId);}finally{if(browser)await browser.close().catch(()=>{});}
}
module.exports={runProject};
