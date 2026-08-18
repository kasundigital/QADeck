const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const db = require('./db');
const { decrypt } = require('./crypto');

const pageTimeout = Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 20000));
const artifactRoot = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');
const VIEWPORTS = { desktop:{width:1440,height:900}, laptop:{width:1366,height:768}, tablet:{width:768,height:1024}, mobile:{width:390,height:844}, 'small-mobile':{width:360,height:800} };
const enabled = (v) => Number(v) === 1 || v === true;

function cleanUrl(raw, base) { try { const url=new URL(raw,base); return ['http:','https:'].includes(url.protocol)?url.toString():null; } catch { return null; } }
function parseViewports(project) { try { const p=JSON.parse(project.viewport_profiles||'[]'); const v=Array.isArray(p)?p.filter((n)=>VIEWPORTS[n]):[]; return v.length?v:['desktop']; } catch { return ['desktop']; } }
function parseExtraLoginFields(source) { if(!source?.extra_login_fields_enc)return[]; try{const p=JSON.parse(decrypt(source.extra_login_fields_enc));return Array.isArray(p)?p.slice(0,20):[];}catch{return[];} }
async function visible(locator){try{if(!(await locator.count()))return null;const f=locator.first();return await f.isVisible({timeout:500})?f:null;}catch{return null;}}
async function firstVisible(page,selectors){for(const s of selectors){const f=await visible(page.locator(s));if(f)return f;}return null;}
async function findExtraField(page,field){if(field.selector){const f=await visible(page.locator(field.selector));if(f)return f;}if(field.name){try{const l=await visible(page.getByLabel(field.name,{exact:false}));if(l)return l;}catch{}const safe=String(field.name).replace(/"/g,'\\"');return firstVisible(page,[`[name="${safe}"]`,`input[placeholder*="${safe}" i]`,`input[aria-label*="${safe}" i]`,`select[aria-label*="${safe}" i]`]);}return null;}
async function findUsername(page){const f=await firstVisible(page,['input[type="email"]','input[name*="email" i]','input[name*="username" i]','input[name*="user" i]','input[name*="login" i]','input[autocomplete="username"]']);if(f)return f;const texts=page.locator('input[type="text"]:visible');const count=await texts.count();return count?texts.nth(count-1):null;}

async function attemptLogin(page, project, source) {
  if(!source?.login_url || !source.username || !source.password_enc)return;
  const loginUrl=cleanUrl(source.login_url,project.base_url);if(!loginUrl)throw new Error('Invalid login URL');
  await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:pageTimeout});
  for(const field of parseExtraLoginFields(source)){const locator=await findExtraField(page,field);if(!locator)throw new Error(`Could not find extra login field: ${field.name||field.selector}`);const tag=await locator.evaluate((e)=>e.tagName.toLowerCase());if(field.type==='select'||tag==='select')await locator.selectOption({label:String(field.value||'')}).catch(()=>locator.selectOption(String(field.value||'')));else await locator.fill(String(field.value||''));}
  const username=await findUsername(page),password=await firstVisible(page,['input[type="password"]','input[autocomplete="current-password"]']);if(!username||!password)throw new Error('Could not identify username/password fields');
  await username.fill(source.username);await password.fill(decrypt(source.password_enc));
  const submit=await firstVisible(page,['button[type="submit"]','input[type="submit"]','button:has-text("Login")','button:has-text("Log in")','button:has-text("Sign in")']);if(!submit)throw new Error('Could not identify login submit button');
  await submit.click();await page.waitForLoadState('domcontentloaded',{timeout:pageTimeout}).catch(()=>{});await page.waitForTimeout(500);
}
function requireTarget(step){if(!step.target)throw new Error(`${step.action} requires a target`);return step.target;}
function jsonPath(obj,pathText){return String(pathText||'').split('.').filter(Boolean).reduce((v,k)=>v==null?undefined:v[k],obj);}

async function executeStep(page, step, project, screenshotPath, state) {
  switch(step.action){
    case 'visit':{const raw=step.value||step.target;if(!raw)throw new Error('Visit requires a URL/path');const url=cleanUrl(raw,project.base_url);if(!url)throw new Error(`Invalid URL: ${raw}`);await page.goto(url,{waitUntil:'domcontentloaded',timeout:pageTimeout});await page.waitForTimeout(250);return `Visited ${url}`;}
    case 'click': await page.locator(requireTarget(step)).first().click({timeout:pageTimeout});await page.waitForTimeout(200);return `Clicked ${step.target}`;
    case 'fill': await page.locator(requireTarget(step)).first().fill(String(step.value||''));return `Filled ${step.target}`;
    case 'select':{const l=page.locator(requireTarget(step)).first();await l.selectOption({label:String(step.value||'')}).catch(()=>l.selectOption(String(step.value||'')));return `Selected ${step.value||''}`;}
    case 'check': await page.locator(requireTarget(step)).first().check();return `Checked ${step.target}`;
    case 'uncheck': await page.locator(requireTarget(step)).first().uncheck();return `Unchecked ${step.target}`;
    case 'expect_text':{const l=step.target?page.locator(step.target).first():page.locator('body');await l.waitFor({state:'visible',timeout:pageTimeout});const text=await l.innerText(),expected=String(step.value||'');if(!text.includes(expected))throw new Error(`Expected text not found: ${expected}`);return `Found expected text: ${expected}`;}
    case 'expect_url':{const expected=String(step.value||step.target||'');if(!expected)throw new Error('Expect URL requires a value');await page.waitForURL((u)=>u.href.includes(expected),{timeout:pageTimeout});return `URL contains ${expected}`;}
    case 'wait':{const ms=Math.min(30000,Math.max(0,Number(step.value||step.target||1000)));await page.waitForTimeout(ms);return `Waited ${ms} ms`;}
    case 'screenshot': await page.screenshot({path:screenshotPath,fullPage:true});return 'Screenshot captured';
    case 'api_get':{
      const url=cleanUrl(requireTarget(step),project.base_url);if(!url)throw new Error('Invalid API URL');let headers={};if(step.value){try{headers=JSON.parse(step.value);}catch{throw new Error('API GET Value must be JSON headers or blank');}}
      const r=await page.context().request.get(url,{headers});const text=await r.text();let body=text;try{body=JSON.parse(text);}catch{}state.lastApi={status:r.status(),body,text,url};return `GET ${url} → ${r.status()}`;
    }
    case 'api_post':{
      const url=cleanUrl(requireTarget(step),project.base_url);if(!url)throw new Error('Invalid API URL');let data={};if(step.value){try{data=JSON.parse(step.value);}catch{throw new Error('API POST Value must be valid JSON');}}
      const r=await page.context().request.post(url,{data});const text=await r.text();let body=text;try{body=JSON.parse(text);}catch{}state.lastApi={status:r.status(),body,text,url};return `POST ${url} → ${r.status()}`;
    }
    case 'expect_status':{if(!state.lastApi)throw new Error('No previous API response');const expected=Number(step.value||step.target);if(state.lastApi.status!==expected)throw new Error(`Expected HTTP ${expected}, got ${state.lastApi.status}`);return `API status is ${expected}`;}
    case 'expect_json':{if(!state.lastApi)throw new Error('No previous API response');const actual=jsonPath(state.lastApi.body,requireTarget(step));const expected=String(step.value??'');if(String(actual)!==expected)throw new Error(`Expected ${step.target}=${expected}, got ${String(actual)}`);return `JSON ${step.target} matched`;}
    default: throw new Error(`Unsupported scenario action: ${step.action}`);
  }
}
function updateRun(runId,completed,issues,passed,current){db.prepare(`UPDATE test_runs SET pages_scanned=?,issues_count=?,clean_pages=?,current_url=?,heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(completed,issues,passed,current,runId);}

async function runScenario(runId,project,scenarioId,options={}){
  const workerId=options.workerId||null,scenario=db.prepare('SELECT * FROM test_scenarios WHERE id=? AND project_id=?').get(scenarioId,project.id);if(!scenario)throw new Error('Scenario not found');
  const steps=db.prepare('SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY position').all(scenario.id);if(!steps.length)throw new Error('Scenario has no steps');
  const role=scenario.role_id?db.prepare('SELECT * FROM project_roles WHERE id=? AND project_id=?').get(scenario.role_id,project.id):null;
  const loginSource=enabled(scenario.use_project_login) ? (role || project) : null;
  const retries=Math.max(0,Math.min(3,Number(scenario.retry_count||0)));
  const runDir=path.join(artifactRoot,String(runId)),videoDir=path.join(runDir,'videos');fs.mkdirSync(runDir,{recursive:true});if(enabled(project.enable_video))fs.mkdirSync(videoDir,{recursive:true});
  db.prepare(`UPDATE test_runs SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP),worker_id=COALESCE(worker_id,?),heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(workerId,runId);
  let browser,completed=0,passed=0,issues=0,firstTracePath=null,firstVideoPath=null;
  const insertResult=db.prepare(`INSERT INTO scenario_step_results (run_id,scenario_id,step_id,position,action,status,message,screenshot_path,viewport,attempts,flaky) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertIssue=db.prepare(`INSERT INTO test_issues (run_id,page_id,severity,category,message,details) VALUES (?,NULL,?,?,?,?)`);
  try{
    browser=await chromium.launch({headless:true});
    for(const viewportName of parseViewports(project)){
      const viewport=VIEWPORTS[viewportName]||VIEWPORTS.desktop;let context,page,videoHandle=null,traceStarted=false,viewportFailed=false;const state={lastApi:null};
      try{
        context=await browser.newContext({viewport,userAgent:`QADeck/0.5 Scenario Runner (${viewportName})`,recordVideo:enabled(project.enable_video)?{dir:videoDir,size:viewport}:undefined});
        if(enabled(project.enable_trace)){await context.tracing.start({screenshots:true,snapshots:true,sources:false});traceStarted=true;}
        page=await context.newPage();videoHandle=page.video();page.setDefaultTimeout(pageTimeout);
        if(loginSource){try{await attemptLogin(page,project,loginSource);}catch(error){issues++;insertIssue.run(runId,'high','scenario',`Login failed before scenario: ${scenario.name}`,`${viewportName}: ${error.message}`);}}
        for(let index=0;index<steps.length;index++){
          const step=steps[index],current=`${viewportName}: step ${step.position} ${step.action}`;updateRun(runId,completed,issues,passed,current);
          const screenshotFile=`scenario-${scenario.id}-${viewportName}-step-${step.position}.png`,screenshotAbsolute=path.join(runDir,screenshotFile),screenshotWeb=`/artifacts/${runId}/${screenshotFile}`;
          let success=false,lastError=null,message='',attempts=0;
          for(let attempt=0;attempt<=retries;attempt++){
            attempts=attempt+1;
            try{message=await executeStep(page,step,project,screenshotAbsolute,state);success=true;break;}catch(error){lastError=error;if(attempt<retries)await page.waitForTimeout(500);}
          }
          if(success){completed++;passed++;const flaky=attempts>1?1:0;const saved=step.action==='screenshot'&&fs.existsSync(screenshotAbsolute)?screenshotWeb:null;insertResult.run(runId,scenario.id,step.id,step.position,step.action,flaky?'flaky':'pass',message,saved,viewportName,attempts,flaky);if(flaky){issues++;insertIssue.run(runId,'low','flaky',`Scenario step ${step.position} passed after retry`,`${viewportName}: ${attempts} attempts`);}updateRun(runId,completed,issues,passed,current);continue;}
          completed++;issues++;viewportFailed=true;try{await page.screenshot({path:screenshotAbsolute,fullPage:true});}catch{}const saved=fs.existsSync(screenshotAbsolute)?screenshotWeb:null;insertResult.run(runId,scenario.id,step.id,step.position,step.action,'fail',lastError?.message||'Failed',saved,viewportName,attempts,0);insertIssue.run(runId,'high','scenario',`Scenario step ${step.position} failed: ${step.action}`,`${viewportName}: ${lastError?.message||'Failed'} (${attempts} attempts)`);updateRun(runId,completed,issues,passed,current);
          for(const remaining of steps.slice(index+1))insertResult.run(runId,scenario.id,remaining.id,remaining.position,remaining.action,'skipped','Skipped after an earlier step failed.',null,viewportName,0,0);break;
        }
      }catch(error){issues++;viewportFailed=true;insertIssue.run(runId,'high','scenario',`Scenario viewport failed: ${viewportName}`,error.message);}finally{
        if(context&&traceStarted){const traceFile=`scenario-trace-${viewportName}.zip`,traceAbsolute=path.join(runDir,traceFile);try{await context.tracing.stop({path:traceAbsolute});if(!firstTracePath)firstTracePath=`/artifacts/${runId}/${traceFile}`;}catch{}}
        if(context)await context.close().catch(()=>{});if(videoHandle){try{const videoAbsolute=await videoHandle.path();if(videoAbsolute&&fs.existsSync(videoAbsolute)&&!firstVideoPath)firstVideoPath=`/artifacts/${path.relative(artifactRoot,videoAbsolute).split(path.sep).join('/')}`;}catch{}}
        if(!viewportFailed)updateRun(runId,completed,issues,passed,null);
      }
    }
    db.prepare(`UPDATE test_runs SET status='completed',completed_at=CURRENT_TIMESTAMP,pages_scanned=?,issues_count=?,clean_pages=?,trace_path=?,video_path=?,current_url=NULL,heartbeat_at=NULL,worker_id=NULL WHERE id=?`).run(completed,issues,passed,firstTracePath,firstVideoPath,runId);
  }catch(error){db.prepare(`UPDATE test_runs SET status='failed',completed_at=CURRENT_TIMESTAMP,pages_scanned=?,issues_count=?,clean_pages=?,error_message=?,trace_path=?,video_path=?,current_url=NULL,heartbeat_at=NULL,worker_id=NULL WHERE id=?`).run(completed,issues,passed,error.message,firstTracePath,firstVideoPath,runId);}finally{if(browser)await browser.close().catch(()=>{});}
}
module.exports={runScenario};
