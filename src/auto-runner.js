const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const db = require('./db');
const { decrypt } = require('./crypto');
const axePath = require.resolve('axe-core/axe.min.js');

const pageTimeout = Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 20000));
const artifactRoot = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');
const VIEWPORTS = {
  desktop:{width:1440,height:900}, laptop:{width:1366,height:768}, tablet:{width:768,height:1024},
  mobile:{width:390,height:844}, 'small-mobile':{width:360,height:800}
};

function enabled(v){ return Number(v)===1 || v===true; }
function cleanUrl(raw,base){ try{const u=new URL(raw,base);return ['http:','https:'].includes(u.protocol)?u.toString():null;}catch{return null;} }
function parseViewports(project){try{const p=JSON.parse(project.viewport_profiles||'[]');const v=Array.isArray(p)?p.filter(n=>VIEWPORTS[n]):[];return v.length?v:['desktop'];}catch{return['desktop'];}}
function parseExtra(source){if(!source?.extra_login_fields_enc)return[];try{const p=JSON.parse(decrypt(source.extra_login_fields_enc));return Array.isArray(p)?p.slice(0,20):[];}catch{return[];}}
async function visible(locator){try{if(!(await locator.count()))return null;const f=locator.first();return await f.isVisible({timeout:500})?f:null;}catch{return null;}}
async function firstVisible(page,selectors){for(const s of selectors){const f=await visible(page.locator(s));if(f)return f;}return null;}
async function findUsername(page){
  const f=await firstVisible(page,['input[type="email"]','input[name*="email" i]','input[name*="username" i]','input[name*="user" i]','input[name*="login" i]','input[autocomplete="username"]']);
  if(f)return f;const t=page.locator('input[type="text"]:visible');return await t.count()?t.nth((await t.count())-1):null;
}
async function findExtra(page,field){
  if(field.selector){const f=await visible(page.locator(field.selector));if(f)return f;}
  if(!field.name)return null;
  try{const f=await visible(page.getByLabel(field.name,{exact:false}));if(f)return f;}catch{}
  const safe=String(field.name).replace(/"/g,'\\"');
  return firstVisible(page,[`[name="${safe}"]`,`input[placeholder*="${safe}" i]`,`select[aria-label*="${safe}" i]`]);
}
async function fillLogin(page,project,source,passwordOverride=null){
  if(!source?.login_url||!source.username||!source.password_enc)throw new Error('Login credentials are not fully configured.');
  const loginUrl=cleanUrl(source.login_url,project.base_url);if(!loginUrl)throw new Error('Invalid login URL.');
  await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:pageTimeout});
  for(const field of parseExtra(source)){const l=await findExtra(page,field);if(!l)throw new Error(`Could not find login field: ${field.name||field.selector}`);const tag=await l.evaluate(e=>e.tagName.toLowerCase());if(field.type==='select'||tag==='select')await l.selectOption({label:String(field.value||'')}).catch(()=>l.selectOption(String(field.value||'')));else await l.fill(String(field.value||''));}
  const u=await findUsername(page),p=await firstVisible(page,['input[type="password"]','input[autocomplete="current-password"]']);
  if(!u||!p)throw new Error('Could not identify username/password fields.');
  await u.fill(source.username);await p.fill(passwordOverride===null?decrypt(source.password_enc):passwordOverride);
  const submit=await firstVisible(page,['button[type="submit"]','input[type="submit"]','button:has-text("Login")','button:has-text("Log in")','button:has-text("Sign in")']);
  if(!submit)throw new Error('Could not identify login submit button.');
  await submit.click();await page.waitForLoadState('domcontentloaded',{timeout:pageTimeout}).catch(()=>{});await page.waitForTimeout(500);
  return {loginUrl,stillLogin:await page.locator('input[type="password"]:visible').count()>0,url:page.url()};
}
async function runAxe(page){
  await page.addScriptTag({path:axePath});
  const r=await page.evaluate(async()=>window.axe.run(document,{resultTypes:['violations'],rules:{region:{enabled:false}}}));
  return r.violations||[];
}
async function responsiveProblems(page){
  return page.evaluate(()=>{
    const doc=document.documentElement;
    const overflow=Math.max(doc.scrollWidth,document.body?.scrollWidth||0)-window.innerWidth;
    const offenders=[];
    for(const el of [...document.querySelectorAll('body *')]){
      const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden')continue;
      const r=el.getBoundingClientRect();
      if(r.width>0 && (r.right>window.innerWidth+8 || r.left<-8) && s.position!=='fixed') offenders.push((el.id?'#'+el.id:el.className?'.'+String(el.className).trim().split(/\s+/).join('.') : el.tagName.toLowerCase()).slice(0,120));
      if(offenders.length>=8)break;
    }
    return {overflow,offenders};
  });
}
async function keyboardSmoke(page){
  return page.evaluate(async()=>{
    const focusables=[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&!el.disabled;});
    return {focusableCount:focusables.length};
  });
}
async function tapKeyboard(page,count){
  const seen=new Set(),missingFocus=[];
  for(let i=0;i<Math.min(25,Math.max(1,count));i++){
    await page.keyboard.press('Tab');
    const state=await page.evaluate(()=>{
      const e=document.activeElement;if(!e||e===document.body)return {key:'body',visible:false};
      const s=getComputedStyle(e);const r=e.getBoundingClientRect();
      const visible=r.width>0&&r.height>0;
      const focusVisible=s.outlineStyle!=='none'||s.boxShadow!=='none'||s.borderColor!=='rgba(0, 0, 0, 0)';
      const key=e.id?'#'+e.id:e.getAttribute('name')||e.getAttribute('aria-label')||e.tagName;
      return {key:String(key).slice(0,100),visible:visible&&focusVisible};
    });
    seen.add(state.key);if(!state.visible)missingFocus.push(state.key);
  }
  return {unique:seen.size,missingFocus:[...new Set(missingFocus)].slice(0,8)};
}
async function safeRequiredFormProbe(page){
  const forms=page.locator('form:visible');const total=await forms.count(),results=[];
  for(let i=0;i<Math.min(total,8);i++){
    const form=forms.nth(i);
    const required=await form.locator('[required]:visible').count();
    if(!required)continue;
    const submit=await visible(form.locator('button[type="submit"],input[type="submit"]'));
    if(!submit)continue;
    const valid=await form.evaluate(f=>f.checkValidity());
    results.push({required,valid});
  }
  return results;
}

async function runAutoSuite(runId,project,options={}){
  const workerId=options.workerId||null;
  const runDir=path.join(artifactRoot,String(runId));fs.mkdirSync(runDir,{recursive:true});
  const addIssue=db.prepare('INSERT INTO test_issues (run_id,page_id,severity,category,message,details) VALUES (?,?,?,?,?,?)');
  const addPage=db.prepare('INSERT INTO test_pages (run_id,url,title,status_code,screenshot_path,duration_ms,viewport,accessibility_count,performance_score) VALUES (?,?,?,?,?,?,?,?,?)');
  db.prepare("UPDATE test_runs SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP),worker_id=COALESCE(worker_id,?),heartbeat_at=CURRENT_TIMESTAMP WHERE id=?").run(workerId,runId);
  let browser,checks=0,passed=0,issues=0;
  const issue=(pageId,severity,category,message,details='')=>{issues++;addIssue.run(runId,pageId,severity,category,message,String(details||''));};
  const progress=(label)=>db.prepare('UPDATE test_runs SET pages_scanned=?,issues_count=?,clean_pages=?,current_url=?,heartbeat_at=CURRENT_TIMESTAMP WHERE id=?').run(checks,issues,passed,label,runId);
  try{
    browser=await chromium.launch({headless:true});

    // Authentication matrix: valid login, invalid password and logout/session.
    if(project.login_url&&project.username&&project.password_enc){
      progress('Automated authentication matrix');
      let context=await browser.newContext({viewport:VIEWPORTS.desktop});
      let page=await context.newPage();page.setDefaultTimeout(pageTimeout);
      try{
        const r=await fillLogin(page,project,project);checks++;
        if(r.stillLogin)issue(null,'high','authentication','Valid credentials did not leave the login form',r.url);else passed++;
        const protectedUrl=page.url();
        const logout=await firstVisible(page,['a[href*="logout" i]','a[href*="signout" i]','button:has-text("Logout")','button:has-text("Log out")','button:has-text("Sign out")']);
        if(logout){
          await logout.click();await page.waitForLoadState('domcontentloaded',{timeout:pageTimeout}).catch(()=>{});await page.waitForTimeout(300);
          await page.goto(protectedUrl,{waitUntil:'domcontentloaded',timeout:pageTimeout}).catch(()=>{});
          checks++;
          if(await page.locator('input[type="password"]:visible').count())passed++;else issue(null,'high','authentication','Logout/session invalidation could not be confirmed',`Protected URL remained accessible after logout: ${protectedUrl}`);
        }else{checks++;issue(null,'medium','authentication','Logout control was not automatically discoverable','Valid login worked, but QADeck could not find a logout/sign-out control.');}
      }catch(e){checks++;issue(null,'high','authentication','Valid-login test failed',e.message);}
      await context.close();

      context=await browser.newContext({viewport:VIEWPORTS.desktop});page=await context.newPage();page.setDefaultTimeout(pageTimeout);
      try{
        const r=await fillLogin(page,project,project,'QADeck_Invalid_'+Date.now());checks++;
        if(r.stillLogin)passed++;else issue(null,'high','authentication','Invalid password may have been accepted',r.url);
      }catch(e){checks++;issue(null,'medium','authentication','Invalid-login test could not complete',e.message);}
      await context.close();
    }

    // Role login matrix.
    const roles=db.prepare('SELECT * FROM project_roles WHERE project_id=? ORDER BY id').all(project.id);
    for(const role of roles){
      if(!role.login_url||!role.username||!role.password_enc)continue;
      progress(`Role login: ${role.name}`);
      const context=await browser.newContext({viewport:VIEWPORTS.desktop});const page=await context.newPage();page.setDefaultTimeout(pageTimeout);
      try{const r=await fillLogin(page,project,role);checks++;if(r.stillLogin)issue(null,'high','authorization',`Role login failed: ${role.name}`,r.url);else passed++;}catch(e){checks++;issue(null,'high','authorization',`Role login failed: ${role.name}`,e.message);}finally{await context.close();}
    }
    if(/role|admin|staff|viewer|permission/i.test(roles.map(r=>r.name).join(' ')) && roles.length<2){issue(null,'medium','authorization','Role-boundary coverage is incomplete','Add at least two configured role accounts so QADeck can compare permission boundaries automatically.');}

    // Responsive + accessibility + keyboard + safe form validation.
    for(const viewportName of parseViewports(project)){
      progress(`Autonomous browser checks: ${viewportName}`);
      const context=await browser.newContext({viewport:VIEWPORTS[viewportName],bypassCSP:true});
      const page=await context.newPage();page.setDefaultTimeout(pageTimeout);
      const started=Date.now();let status=0;
      try{
        if(project.login_url&&project.username&&project.password_enc)await fillLogin(page,project,project).catch(()=>{});
        const url=cleanUrl(project.base_url,project.base_url);const resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:pageTimeout});status=resp?.status()||0;await page.waitForTimeout(500);
        const shot=`auto-${viewportName}.png`,abs=path.join(runDir,shot);await page.screenshot({path:abs,fullPage:true}).catch(()=>{});
        let a11y=[];try{a11y=enabled(project.enable_accessibility)?await runAxe(page):[];}catch{}
        const pageId=Number(addPage.run(runId,page.url(),`Autonomous QA · ${viewportName}`,status,fs.existsSync(abs)?`/artifacts/${runId}/${shot}`:null,Date.now()-started,viewportName,a11y.length,100).lastInsertRowid);
        checks++;
        if(status>=400)issue(pageId,status>=500?'critical':'high','http',`HTTP ${status} during autonomous test`,page.url());
        const responsive=await responsiveProblems(page);if(responsive.overflow>8)issue(pageId,'high','responsive',`Horizontal overflow detected (${Math.round(responsive.overflow)}px)`,responsive.offenders.join(', '));
        for(const v of a11y.slice(0,20))issue(pageId,['critical','serious'].includes(v.impact)?'high':v.impact==='moderate'?'medium':'low','accessibility',v.help||v.id,(v.nodes||[]).slice(0,3).flatMap(n=>n.target||[]).join(', '));
        const k=await keyboardSmoke(page);if(k.focusableCount){const t=await tapKeyboard(page,k.focusableCount);if(t.unique<Math.min(2,k.focusableCount))issue(pageId,'high','keyboard','Keyboard navigation did not move through interactive controls',`Focusable: ${k.focusableCount}; unique focus targets: ${t.unique}`);if(t.missingFocus.length)issue(pageId,'medium','keyboard','Some keyboard-focused controls may lack visible focus',t.missingFocus.join(', '));}
        const formProbe=await safeRequiredFormProbe(page);for(const f of formProbe){if(f.valid)issue(pageId,'medium','validation','A visible form with required fields reports valid while blank',`Required fields detected: ${f.required}`);}
        if(status<400 && responsive.overflow<=8 && !a11y.some(v=>['critical','serious'].includes(v.impact)))passed++;
      }catch(e){checks++;issue(null,'high','automation',`Autonomous ${viewportName} browser test failed`,e.message);}finally{await context.close();}
    }

    db.prepare("UPDATE test_runs SET status='completed',completed_at=CURRENT_TIMESTAMP,pages_scanned=?,issues_count=?,clean_pages=?,current_url=NULL,heartbeat_at=NULL,worker_id=NULL WHERE id=?").run(checks,issues,passed,runId);
  }catch(e){
    db.prepare("UPDATE test_runs SET status='failed',completed_at=CURRENT_TIMESTAMP,pages_scanned=?,issues_count=?,clean_pages=?,error_message=?,current_url=NULL,heartbeat_at=NULL,worker_id=NULL WHERE id=?").run(checks,issues,passed,e.message||String(e),runId);
  }finally{if(browser)await browser.close().catch(()=>{});}
}

module.exports={runAutoSuite};
