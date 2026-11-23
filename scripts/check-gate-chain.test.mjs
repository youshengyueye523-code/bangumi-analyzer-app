import{runChainExtensions}from'./fixtures/gate-chain-extensions.mjs';
import{test}from'node:test';import assert from'node:assert/strict';import{mkdtempSync,cpSync,writeFileSync,readFileSync,mkdirSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{fileURLToPath}from'node:url';import{spawnSync}from'node:child_process';
test('unified chain: original independent 39, actual fresh producers',async t=>{
 const prefix=join(tmpdir(),'bangumi-unified-chain-'),root=mkdtempSync(prefix),node=process.execPath;try{
 for(const[from,to]of[['./fixtures/gate-sum-cases.mjs','independent-review.mjs'],['./fixtures/gate-sum-model.mjs','review-model.mjs'],['./fixtures/gate-sum-producer.mjs','review-producer.mjs'],['./gate-evidence-contract.mjs','codec.mjs']])cpSync(fileURLToPath(new URL(from,import.meta.url)),join(root,to));
 writeFileSync(join(root,'review-contract.mjs'),"export{PROFILE,sha256 as hash,claimDigest as claimSha,basisDigest as policySha,resultDigest as rawSha}from'./codec.mjs';");
 const checker=process.env.GATE_CHECKER_URL?fileURLToPath(process.env.GATE_CHECKER_URL):fileURLToPath(new URL('./check-data-quality-gate.mjs',import.meta.url));
 const run=spawnSync(node,[join(root,'independent-review.mjs')],{encoding:'utf8',windowsHide:true,maxBuffer:5000000,env:{...process.env,GATE_SUM_ROOT:root,REVIEW_CHECKER:checker,REVIEW_CASES:'sum39'}});
 if(process.env.GATE_EVIDENCE_DIR){mkdirSync(process.env.GATE_EVIDENCE_DIR,{recursive:true});cpSync(root,join(process.env.GATE_EVIDENCE_DIR,'sum-execution'),{recursive:true});writeFileSync(join(process.env.GATE_EVIDENCE_DIR,'sum39.log'),(run.stdout??'')+(run.stderr??''));}
 const {evaluateGate}=await import(new URL('file:///'+checker.replaceAll('\\','/')));
 const ext=runChainExtensions(join(root,'sum39/base'),join(root,'extensions'),evaluateGate);
 if(process.env.GATE_EVIDENCE_DIR)cpSync(join(root,'extensions'),join(process.env.GATE_EVIDENCE_DIR,'extensions'),{recursive:true});
 for(const x of ext.results)await t.test(x.name,()=>assert.equal(x.pass,true,JSON.stringify(x.actual)));
 const output=JSON.parse(readFileSync(join(root,'sum39/results.json'),'utf8'));const legacy='witness-original-whitespace-semantic-equivalence';
 for(const x of output.results)if(x.name===legacy)await t.test('CONTRACT byte integrity; archived whitespace-positive remains incompatible',()=>{assert.equal(x.expected,'READY_FOR_FINAL_SCOPE');assert.equal(x.pass,false);assert.equal(x.actual.status,'INVALID');assert(x.actual.errors.some(x=>x.includes('file_hash_mismatch')));});else await t.test(x.name,()=>assert.equal(x.pass,true,JSON.stringify(x.actual)));
 assert.deepEqual(output.results.filter(x=>!x.pass).map(x=>x.name),[legacy]);assert.equal(run.status,1,'Original expectation intentionally retained; only approved legacy mismatch is allowed');
 }finally{if(!resolve(root).startsWith(resolve(prefix)))throw Error('Unsafe fixture root');rmSync(root,{recursive:true,force:true});}
});
