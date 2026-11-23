import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { AnalyzerSupervisor } from '../../runtime/supervisor.mjs';
import { checkPackage, sha256 } from '../../runtime/package-check.mjs';
import { BridgeEngine } from '../engine.mjs';
import { desktopEnvironment, extractR2, host, newWork, repo, ZIP_HASH, zip } from '../scripts/isolated.mjs';

const work=await newWork('desktop-acceptance');
const report={startedAt:new Date().toISOString(),kind:'real-visible-electron-actual-r2-jsonl',work,checks:[],zipSha256:ZIP_HASH,local8787Access:false,paidAI:false,externalBangumi:false};
const check=(name,ok=true)=>{assert.ok(ok,name);report.checks.push(name);console.log('PASS '+name);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const noFile=async p=>{try{await access(p);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}};
let app, page, other, competitor;
async function bridge(method) { return page.evaluate(m=>window.companionBridge[m](),method); }
async function until(predicate,ms=90000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const s=await bridge('getStatus');if(predicate(s))return s;await wait(100);}
  assert.fail('Desktop did not reach required status');
}
async function health(url) {assert.equal(new URL(url).hostname,'127.0.0.1');assert.notEqual(new URL(url).port,'8787');const r=await fetch(url+'api/health',{signal:AbortSignal.timeout(3000)});assert.equal(r.status,200);return r.json();}
async function baseline() {
  const files=['companion/runtime/cli.mjs','companion/runtime/supervisor.mjs','companion/runtime/package-check.mjs'];
  const rows=[];for(const p of files)rows.push({path:p,sha256:await sha256(join(repo,p))});return rows;
}
try {
  report.runtimeBefore=await baseline();
  const a=await extractR2(work,'Analyzer A 空库 & 宿主'),b=await extractR2(work,'Analyzer B 独立外部实例');report.copies=[a,b];
  check('Two new independent r2 copies, empty data and trusted original ZIP',await noFile(join(a,'data'))&&await noFile(join(b,'data'))&&await sha256(zip)===ZIP_HASH);
  other=new AnalyzerSupervisor({packageRoot:b,openBrowser:async()=>{}});await other.startAnalyzer();
  for(let i=0;i<200&&other.getStatus().state!=='ready';i++)await wait(100);
  assert.equal(other.getStatus().state,'ready');const otherURL=other.getStatus().url;
  app=await _electron.launch({executablePath:join(host,'node_modules/electron/dist/electron.exe'),args:[join(host,'main.mjs'),'--packageRoot',a],cwd:host,env:desktopEnvironment(),timeout:30000});
  page=await app.firstWindow();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.waitForFunction(()=>Boolean(window.companionBridge));await page.locator('.home').waitFor({state:'visible'});
  report.versions=await app.evaluate(()=>process.versions);
  check('Real native desktop window is visible and existing UI Home renders',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
  check('Renderer has isolated bridge v1 but no Node require/process',await page.evaluate(()=>window.companionBridge.bridgeVersion===1&&typeof require==='undefined'&&typeof process==='undefined'));
  await page.screenshot({path:join(work,'desktop-home-idle.png')});
  console.log('WINDOW_READY '+JSON.stringify({work}));
  if(process.argv.includes('--observe')) {
    const deadline=Date.now()+180000;
    while(await noFile(join(work,'continue'))&&Date.now()<deadline)await wait(500);
    assert.equal(await noFile(join(work,'continue')),false,'Window observation gate acknowledged');
  }
  check('Open before readiness fails safely',(await bridge('openAnalyzer')).opened===false);
  await page.evaluate(()=>{window.bridgeUpdates=[];window.stopUpdates=window.companionBridge.onStatus(s=>window.bridgeUpdates.push({state:s.state,rawState:s.rawState,owns:s.ownsProcess}));});
  // Real failure and retry, only modifying an untouched disposable package README.
  const readme=join(a,'README.txt'),bytes=await readFile(readme);await writeFile(join(work,'README-original.txt'),bytes,{flag:'wx'});await writeFile(readme,'synthetic corrupted copy');
  const broken=await bridge('startAnalyzer');
  check('Broken independent package reports INTEGRITY_FAILED, no service spawned',broken.state==='error'&&broken.error.code==='INTEGRITY_FAILED'&&!broken.ownsProcess);
  await writeFile(readme,bytes);
  // Exercise the existing real Driver via its actual UI button, not a renderer-created mock.
  const buttons=await page.getByRole('button').allTextContents();report.startButtonCandidates=buttons.filter(s=>/启动/.test(s));
  const startButton=page.getByRole('button',{name:/启动 Analyzer|重新启动|重试启动/}).first();
  await startButton.click();
  const running=await until(s=>s.state==='running');report.analyzerPort=running.port;
  check('Existing UI Driver button starts actual Runtime CLI and reaches ready/running',running.rawState==='ready'&&running.ownsProcess&&(await health(running.url)).ok);
  await page.getByText('运行中',{exact:true}).first().waitFor();
  const again=await Promise.all([bridge('startAnalyzer'),bridge('startAnalyzer')]);
  check('Repeated start shares existing service and URL',again.every(s=>s.state==='running'&&s.url===running.url));
  competitor=new BridgeEngine({packageRoot:a});const duplicate=await competitor.startAnalyzer();
  check('Different host engine refuses duplicate package without adopting it',duplicate.error?.runtimeCode==='SESSION_LOCKED'&&!duplicate.ownsProcess);
  await competitor.close();competitor=null;check('Non-owner close leaves owner service alive',(await health(running.url)).ok);
  const opened=await bridge('openAnalyzer');check('Ready-only open uses actual Runtime browser handoff',opened.opened&&opened.url===running.url);
  const logs=await bridge('getLogs');check('Real event logs are available with no private paths/credentials',logs.some(x=>x.event==='READY')&&!/Users\\|token=|apiKey|PRIVATE_CANARY/.test(JSON.stringify(logs)));
  const updates=await page.evaluate(()=>window.bridgeUpdates);
  check('Status subscription pushed transition and ready snapshots',updates.some(x=>x.state==='starting')&&updates.some(x=>x.state==='running'));
  await page.screenshot({path:join(work,'desktop-home-running.png')});
  await page.getByRole('button',{name:/安全停止/}).first().click();const stopped=await until(s=>s.state==='stopped');
  check('Existing UI safe-stop reaches stopped and removes only owned session',!stopped.ownsProcess&&await noFile(join(a,'.analyzer-session.json'))&&(await health(otherURL)).ok);
  const restarted=await bridge('startAnalyzer');assert.equal(restarted.state,'running');
  // Give an unrelated local server a URL; all renderer-originated access must be denied.
  let foreignRequests=0;const foreign=createServer((req,res)=>{foreignRequests++;res.end('must not be loaded');});await new Promise(r=>foreign.listen(0,'127.0.0.1',r));
  try {
    const foreignURL='http://127.0.0.1:'+foreign.address().port+'/';
    await page.evaluate(url=>{window.open(url);const frame=document.createElement('iframe');frame.src=url;document.body.appendChild(frame);location.href=url;},foreignURL);
    await wait(500);
    check('Navigation, popup and subframe requests to another service are blocked',page.url().startsWith('companion://ui/')&&foreignRequests===0&&(await app.windows()).length===1);
  } finally {await new Promise(r=>foreign.close(r));}
  // Deliberately create a second untrusted document in the TEST harness; its preload cannot invoke the owned main-frame bridge.
  const untrusted=await app.evaluate(async ({BrowserWindow},{preload})=>{
    const w=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false}});
    await w.loadURL('data:text/html,<title>Untrusted test frame</title>');
    const result=await w.webContents.executeJavaScript('window.companionBridge.getStatus()');w.destroy();return result;
  },{preload:join(host,'preload.cjs')});
  check('Real IPC rejects a different window/document even with the same preload',untrusted.error?.runtimeCode==='IPC_DENIED');
  // Native close path, NOT Playwright's force-closing application helper.
  const exited=new Promise(resolve=>app.process().once('exit',resolve));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.isVisible()).close());
  let timer;await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native close did not finish safely')),70000);})]).finally(()=>clearTimeout(timer));
  app=null;
  check('Native window close safely stops owned service/CLI, independent external B remains healthy',await noFile(join(a,'.analyzer-session.json'))&&(await health(otherURL)).ok);
  await other.stopAnalyzer();other=null;await checkPackage(a);await checkPackage(b);
  for(const root of[a,b]){const db=new DatabaseSync(join(root,'data/bangumi.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA user_version').get().user_version,15);assert.equal(db.prepare('SELECT count(*) AS n FROM collections').get().n,0);}finally{db.close();}}
  check('Temporary databases intact, Schema 15, empty; both application manifests unchanged');
  report.runtimeAfter=await baseline();assert.deepEqual(report.runtimeAfter,report.runtimeBefore);check('M0 Runtime source bytes unchanged and original r2 ZIP unchanged',await sha256(zip)===ZIP_HASH);
  check('No renderer page errors',pageErrors.length===0);report.pageErrors=pageErrors;report.ok=true;
}catch(error){report.ok=false;report.error=String(error.stack??error);process.exitCode=1;}
finally{
  if(competitor)await competitor.close();
  if(app){try{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.close();});}catch{report.cleanupAttention=true;}}
  if(other){const s=await other.stopAnalyzer();if(s.status.ownsProcess)report.cleanupAttention=true;}
  report.finishedAt=new Date().toISOString();await writeFile(join(work,'verification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,work,error:report.error}));
}
