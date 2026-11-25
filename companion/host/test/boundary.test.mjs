import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALLOWED_ROUTES, allowedRequest, allowedSender, errorInfo, failureView, idle, safeOpenUrl, safeUrl, toUi, UI_URL, validateStatus } from '../contract.mjs';
import { assetPath, serveAsset, CSP } from '../assets.mjs';
import { RuntimeClient } from '../runtime-client.mjs';
import { BridgeEngine } from '../engine.mjs';
import { newWork } from '../scripts/isolated.mjs';

test('M1-A security boundaries and JSONL client (synthetic transport only)', async t => {
  await t.test('strict top-frame and exact-document sender checks', () => {
    const frame = { url: UI_URL }, wc = { mainFrame: frame, isDestroyed: () => false };
    assert.equal(allowedSender({ sender: wc, senderFrame: frame }, wc), true);
    assert.equal(allowedSender({ sender: {}, senderFrame: frame }, wc), false);
    assert.equal(allowedSender({ sender: wc, senderFrame: { url: UI_URL } }, wc), false);
    for (const url of [UI_URL + '&remote=true','file:///index.html','https://untrusted.invalid/','companion://other/index.html']) {
      frame.url = url; assert.equal(allowedSender({ sender: wc, senderFrame: frame }, wc), false);
    }
  });
  await t.test('allowlist rejects unknown methods, URL/path/PID arguments and arrays', () => {
    for (const method of ['getStatus','startAnalyzer','stopAnalyzer','openAnalyzer','getLogs']) assert.equal(allowedRequest({ method }), true);
    for (const route of ALLOWED_ROUTES) assert.equal(allowedRequest({ method: 'openAnalyzer', route }), true);
    for (const badRoute of ['/unknown', '/library?next=http://evil', '//evil.com', 'https://untrusted.invalid/', 123]) {
      assert.equal(allowedRequest({ method: 'openAnalyzer', route: badRoute }), false);
    }
    assert.equal(allowedRequest({ method: 'getStatus', route: '/library' }), false);
    assert.equal(allowedRequest({ method: 'openAnalyzer', route: '/library', extra: true }), false);
    for (const value of [null, [], 'getStatus', { method: 'exec' }, { method: 'openAnalyzer', url: 'PRIVATE_CANARY' }, { method: 'stopAnalyzer', pid: 123 }]) assert.equal(allowedRequest(value), false);
    assert.throws(() => new BridgeEngine({ packageRoot:'unused',port:8787 }), { code:'INVALID_PORT' });
  });
  await t.test('status mapping preserves ownership, package revision metadata, refuses foreign URLs and never exposes paths/unknown metadata', () => {
    const raw = { ...idle(), state:'ready', ownsProcess:true, url:'http://127.0.0.1:19091/', package:{state:'valid',version:'2.0.0',distributionRevision:5,files:3256},
      dataDir:'PRIVATE_CANARY',pid:999,logs:[] };
    const ui = toUi(validateStatus(raw), 1);
    assert.equal(ui.state, 'running'); assert.equal(ui.runtime.ownsProcess, true); assert.equal(ui.port,19091);
    assert.equal(ui.package.distributionRevision, 5); assert.equal(ui.package.files, 3256);
    assert.equal(ui.pid,null); assert.equal(ui.dataDir,null); assert.ok(!JSON.stringify(ui).includes('PRIVATE_CANARY'));
    for (const route of ALLOWED_ROUTES) {
      assert.equal(safeOpenUrl(`http://127.0.0.1:19091${route}`), `http://127.0.0.1:19091${route}`);
    }
    for (const badOpen of ['http://127.0.0.1:8787/library', 'http://127.0.0.1:19091/unknown', 'http://localhost:19091/series', 'https://untrusted.invalid/series']) {
      assert.equal(safeOpenUrl(badOpen), null);
    }
    for(const url of ['http://127.0.0.1:8787/','http://localhost:19091/','https://untrusted.invalid/','http://127.0.0.1:19091/?token=secret']) {
      assert.equal(safeUrl(url),null); assert.throws(()=>validateStatus({...raw,url}),{code:'HOST_PROTOCOL'});
    }
    const failed = failureView(ui,'HOST_TIMEOUT'); assert.equal(failed.rawState,'failed'); assert.equal(failed.url,null); assert.equal(failed.ownsProcess,true);
    assert.equal(failed.runtime.state,'failed');
    const faulted = toUi(validateStatus(raw),2,'HOST_TIMEOUT');
    assert.equal(faulted.runtime.state,faulted.rawState); assert.equal(faulted.state,'error'); assert.equal(faulted.ownsProcess,true);
  });
  await t.test('errors and logs use fixed code/time/level allowlists', () => {
    assert.ok(!JSON.stringify(errorInfo('token=PRIVATE_CANARY')).includes('PRIVATE_CANARY'));
    assert.throws(()=>validateStatus({...idle(),logs:[{seq:1,at:new Date().toISOString(),level:'info',event:'PRIVATE_CANARY'}]}),{code:'HOST_PROTOCOL'});
    assert.throws(()=>validateStatus({...idle(),error:{code:'PRIVATE_CANARY'}}),{code:'HOST_PROTOCOL'});
    const raw = validateStatus({...idle(),state:'failed',error:{code:'INTERNAL',message:'PRIVATE_CANARY'}});
    assert.ok(!JSON.stringify(raw).includes('PRIVATE_CANARY'));
  });
  await t.test('custom protocol cannot read outside UI snapshot or POST and forbids remote capabilities', async () => {
    const root = join(process.cwd(),'companion/host/.work/example-ui');
    for(const u of ['file:///private.json','companion://other/index.html','companion://ui/%2e%2e/private.json','companion://ui/%5c..%5cprivate.js','companion://ui/index.html%00']) assert.equal(assetPath(u,root),null);
    assert.ok(assetPath(UI_URL,root).file.startsWith(root));
    assert.equal((await serveAsset({url:UI_URL,method:'POST'},root)).status,403);
    assert.match(CSP,/connect-src 'none'/); assert.match(CSP,/frame-src 'none'/);
    const scriptSrc = CSP.split(';').map(s=>s.trim()).find(s=>s.startsWith('script-src '));
    assert.ok(scriptSrc);
    const scriptTokens = scriptSrc.split(/\s+/).slice(1);
    assert.ok(scriptTokens.includes("'self'"));
    assert.ok(scriptTokens.includes("'wasm-unsafe-eval'"));
    assert.ok(!scriptTokens.includes("'unsafe-eval'"));
    assert.ok(!scriptTokens.includes("'unsafe-inline'"));
  });
  const dir=await newWork('rpc-unit'), root=join(dir,'synthetic-node');
  await mkdir(join(root,'runtime'),{recursive:true}); await copyFile(process.execPath,join(root,'runtime/node.exe'));
  const fake = async (name, source) => { const p=join(dir,name+'.mjs'); await writeFile(p,source,{flag:'wx'}); return p; };
  const fixturePrefix = `import readline from 'node:readline';const base=${JSON.stringify(idle())};const input=readline.createInterface({input:process.stdin});input.on('close',()=>process.exit(0));`;
  await t.test('JSONL correlates out-of-order responses and validates actions', async () => {
    const cliPath=await fake('order',fixturePrefix+`input.on('line',l=>{const q=JSON.parse(l);setTimeout(()=>console.log(JSON.stringify({id:q.id,ok:true,status:{...base,logs:[{seq:q.id,at:new Date().toISOString(),level:'info',event:'CREATED'}]}})),q.id===1?80:10);});`);
    const c=new RuntimeClient({packageRoot:root,cliPath});
    try {
      const [a,b]=await Promise.all([c.call('getStatus'),c.call('getStatus')]);
      assert.equal(a.status.logs[0].seq,1);assert.equal(b.status.logs[0].seq,2);
      await assert.rejects(c.call('exec'),{code:'IPC_DENIED'});
    } finally {await c.end();}
  });
  await t.test('timeout retains uncertain request until late response, not a new CLI or retry', async () => {
    const cliPath=await fake('late',fixturePrefix+`input.on('line',l=>{const q=JSON.parse(l);setTimeout(()=>console.log(JSON.stringify({id:q.id,ok:true,status:base})),200);});`);
    const c=new RuntimeClient({packageRoot:root,cliPath});
    try {
      await assert.rejects(c.call('startAnalyzer',30),{code:'HOST_TIMEOUT'}); assert.equal(c.uncertain('startAnalyzer'),true);
      await new Promise(r=>setTimeout(r,300));assert.equal(c.uncertain('startAnalyzer'),false);
    } finally {await c.end();}
  });
  await t.test('malformed/oversize child output becomes generic protocol failure, no raw forwarding', async () => {
    for(const [name,body] of [['malformed',`console.log('PRIVATE_CANARY not JSON')`],['oversize',`console.log('x'.repeat(70000))`]]) {
      const cliPath=await fake(name,fixturePrefix+`input.on('line',()=>{${body}});`);
      const c=new RuntimeClient({packageRoot:root,cliPath});let fault;c.on('fault',x=>fault=x);
      try {await assert.rejects(c.call('getStatus'),{code:'HOST_PROTOCOL'});assert.equal(fault,'HOST_PROTOCOL');assert.equal(c.dead,true);}
      finally {await c.end();}
    }
  });
  await t.test('transport death fails pending requests and is never auto-recreated', async () => {
    const cliPath=await fake('death',fixturePrefix+`input.on('line',()=>process.exit(4));`);
    const c=new RuntimeClient({packageRoot:root,cliPath});c.on('fault',()=>{});
    await assert.rejects(c.call('getStatus'),{code:'HOST_UNAVAILABLE'});assert.equal(c.dead,true);
    await assert.rejects(c.call('startAnalyzer'),{code:'HOST_UNAVAILABLE'});
  });
});
