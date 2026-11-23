import{readFileSync,writeFileSync,mkdirSync,cpSync,unlinkSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';import assert from'node:assert/strict';import{PROFILE,fixtureBasisDigest}from'./gate-witness-fixture.mjs';import{createLedgerFixture}from'./gate-ledger-factory.mjs';
export function runLedgerCases(root,evaluateGate){const {base}=createLedgerFixture(root);const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase(),read=p=>JSON.parse(readFileSync(p)),write=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2));
const results=[];
function patchProof(p,id,fn){const reg=read(join(p,'registry.json')),e=reg.evidence.find(x=>x.id===id),proof=read(join(p,e.path));fn(proof,e,reg);write(join(p,e.path),proof);e.sha256=sha(readFileSync(join(p,e.path)));write(join(p,'registry.json'),reg);}
function patchRegistry(p,fn){const reg=read(join(p,'registry.json'));fn(reg);write(join(p,'registry.json'),reg);}
function run(name,expected,mutate=()=>{},origin=base){
 const p=join(root,name);cpSync(origin,p,{recursive:true});mutate(p);let actual;try{actual=evaluateGate(join(p,'registry.json'),p);}catch(e){actual={status:'THREW',error:e.message};}
 const pass=expected==='reject'?['INVALID','NOT_READY'].includes(actual.status):expected===actual.status;
 results.push({name,expected,pass,actual});console.log(`${pass?'PASS':'FAIL'} ${name}: ${actual.status}`);
}
run('fresh-valid-complete','READY_FOR_FINAL_SCOPE');
run('developer-only-not-independent','reject',p=>patchRegistry(p,r=>{r.evidence=r.evidence.filter(e=>e.id!=='IND');r.finalIndependentEvidence=['DEV'];}));
run('independent-wrong-claim-scope','reject',p=>patchProof(p,'IND',x=>x.assertions[0].scope='other-object'));
run('developer-kind-relabeled-without-rerun','reject',p=>{
 patchRegistry(p,r=>{r.evidence=r.evidence.filter(e=>e.id!=='IND');r.finalIndependentEvidence=['DEV'];});
 patchProof(p,'DEV',(x,e)=>{x.kind='external-independent';e.kind=x.kind;});
 // Raw result, its hash, executedAt, snapshot, producer, command and assertions are deliberately UNCHANGED.
});
run('historical-cannot-certify-current','reject',p=>patchRegistry(p,r=>{r.evidence.find(e=>e.id==='DEV').usage='historical';r.records[0].evidence=['DEV'];}));
run('failed-bound-assertion','reject',p=>patchProof(p,'DEV',x=>{x.assertions[0].result='failed';}));
run('cross-object-proof-reuse','reject',p=>patchProof(p,'DEV',x=>{x.assertions[0]={...x.assertions[1],id:x.assertions[0].id};}));
run('current-source-with-old-raw-result','reject',p=>{
 const file=join(p,'docs/model.mjs');writeFileSync(file,readFileSync(file,'utf8')+'\n// newly maintained implementation');
 patchRegistry(p,r=>r.sources[0].sha256=sha(readFileSync(file)));
});
run('new-schema-object-unregistered','reject',p=>{
 const c=read(join(p,'docs/census.json'));c.tables.push({table:'unregistered_secret',columns:[{name:'id'}]});write(join(p,'docs/census.json'),c);
 patchRegistry(p,r=>r.schema.sha256=sha(readFileSync(join(p,'docs/census.json'))));
});
run('p0-supported-na','reject',p=>patchRegistry(p,r=>{r.records.find(x=>x.dimension==='repair').status='not-applicable';}));
run('expiry-in-envelope','reject',p=>patchProof(p,'DEV',x=>x.expiresAt='2020-01-01T00:00:00Z'));
run('missing-result-file','reject',p=>patchProof(p,'DEV',x=>x.run.results.path='docs/nonexistent.json'));
run('raw-result-hash-mismatch','reject',p=>patchProof(p,'DEV',x=>x.run.results.sha256='0'.repeat(64)));
run('duplicate-evidence-reference','reject',p=>patchRegistry(p,r=>r.records[0].evidence=['DEV','DEV']));
run('objects-link-reassigned-with-unchanged-proof','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').objects=['field:ledger.id']));
run('objects-link-deleted-with-unchanged-proof','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').objects=[]));

function patchRaw(p,id,fn){const r=read(join(p,'registry.json')),e=r.evidence.find(x=>x.id===id),env=read(join(p,e.path)),raw=read(join(p,env.run.results.path));fn(raw,env,e,r);write(join(p,env.run.results.path),raw);env.run.results.sha256=sha(readFileSync(join(p,env.run.results.path)));write(join(p,e.path),env);e.sha256=sha(readFileSync(join(p,e.path)));write(join(p,'registry.json'),r);}
function patchReceipt(p,fn){const authorityPath=join(p,'docs/quality/review-authority-v1.json'),auth=read(authorityPath),ref=auth.authorizations[0].record,w=read(join(p,ref.path));fn(w);write(join(p,ref.path),w);ref.sha256=sha(readFileSync(join(p,ref.path)));write(authorityPath,auth);}
run('developer-local-behavior-without-final-credential','NOT_READY',p=>patchRegistry(p,r=>{r.evidence=r.evidence.filter(e=>e.id==='DEV');r.finalIndependentEvidence=[];}));
run('all-kind-fields-retagged-no-authorized-review','reject',p=>{patchRegistry(p,r=>{r.evidence=r.evidence.filter(e=>e.id==='DEV');r.finalIndependentEvidence=['DEV'];});patchRaw(p,'DEV',(raw,e,entry)=>{raw.kind=e.kind=entry.kind='external-independent';raw.execution.classification='external-independent';raw.execution.reviewId=e.run.reviewId='not-witnessed';});});
run('developer-run-cannot-borrow-other-review-credential','reject',p=>{patchRegistry(p,r=>{r.evidence=r.evidence.filter(e=>e.id==='DEV');r.finalIndependentEvidence=['DEV'];});patchRaw(p,'DEV',(raw,e,entry)=>{raw.kind=e.kind=entry.kind='external-independent';raw.execution.classification='external-independent';raw.execution.reviewId=e.run.reviewId='synthetic-ledger-review';});});
run('missing-run-classification','reject',p=>patchRaw(p,'DEV',raw=>delete raw.kind));
run('missing-run-identity','reject',p=>patchRaw(p,'DEV',(raw,e)=>{delete raw.execution.id;delete e.run.id;}));
run('conflicting-reused-execution-id','reject',p=>patchRaw(p,'IND',(raw,e,r)=>{const reg=read(join(p,'registry.json')),dev=read(join(p,reg.evidence.find(x=>x.id==='DEV').path));raw.execution.id=e.run.id=dev.run.id;}));
run('envelope-observation-cannot-upgrade-raw','reject',p=>patchProof(p,'DEV',e=>e.observations.objects=[]));
run('envelope-approval-cannot-upgrade-raw','reject',p=>patchProof(p,'DEV',e=>e.approval={approvedBy:'someone',reason:'self-declared'}));
run('raw-expiry-cannot-be-omitted-by-envelope','reject',p=>patchRaw(p,'DEV',raw=>raw.expiresAt='2020-01-01T00:00:00Z'));
run('missing-fixed-review-authority','reject',p=>unlinkSync(join(p,'docs/quality/review-authority-v1.json')));
run('proof-cannot-select-its-own-trust-root','reject',p=>{const path=join(p,'docs/quality/review-authority-v1.json'),auth=read(path);write(join(p,'docs/self-authority.json'),auth);write(path,{...auth,authorizations:[]});patchRegistry(p,r=>r.reviewAuthority={path:'docs/self-authority.json',sha256:sha(readFileSync(join(p,'docs/self-authority.json')))});});
run('duplicate-review-authorization','reject',p=>{const path=join(p,'docs/quality/review-authority-v1.json'),auth=read(path);auth.authorizations.push(structuredClone(auth.authorizations[0]));write(path,auth);});
run('review-execution-exit-failed','reject',p=>patchReceipt(p,w=>{const path=join(p,w.executionRecord.path),log=read(path);log.exitCode=1;write(path,log);w.executionRecord.sha256=sha(readFileSync(path));}));
run('review-execution-identity-does-not-match','reject',p=>patchReceipt(p,w=>{const path=join(p,w.executionRecord.path),log=read(path);log.execution.id='other-execution';write(path,log);w.executionRecord.sha256=sha(readFileSync(path));}));
run('review-receipt-cannot-add-another-object','reject',p=>patchReceipt(p,w=>w.assertions.find(a=>a.id==='risk:projection-length').objects=['field:ledger.id']));
run('historical-review-origin-not-promoted','reject',p=>patchProof(p,'IND',(e,entry)=>{entry.usage='historical';}));
run('objects-duplicate','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').objects=['field:ledger.projected','field:ledger.projected']));
run('objects-not-an-array','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').objects='field:ledger.projected'));
run('objects-missing','reject',p=>patchRegistry(p,r=>delete r.records.find(x=>x.dimension==='anomaly').objects));
run('objects-dangling-or-cross-schema','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').objects=['field:other_schema.projected']));
run('rule-identity-change-invalidates-old-proof','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').invariant='a different invariant'));
const multi=createLedgerFixture(join(root,'multi'),{objects:['field:ledger.original','field:ledger.projected']}).base;
run('valid-multiple-object-contract','READY_FOR_FINAL_SCOPE',()=>{},multi);
run('multi-object-one-link-missing','reject',p=>patchRegistry(p,r=>r.records.find(x=>x.dimension==='anomaly').objects.pop()),multi);
run('legal-registry-basis-envelope-order-equivalence','READY_FOR_FINAL_SCOPE',p=>{patchRegistry(p,r=>{r.records.find(x=>x.dimension==='anomaly').objects.reverse();const path=join(p,r.coverageBasis.path),b=read(path);b.records.find(x=>x.dimension==='anomaly').objects.reverse();write(path,b);r.coverageBasis.sha256=sha(readFileSync(path));});for(const id of ['DEV','IND'])patchProof(p,id,e=>e.assertions.find(a=>a.id==='risk:projection-length').objects.reverse());},multi);
run('legal-raw-object-order-equivalence','READY_FOR_FINAL_SCOPE',p=>{for(const id of ['DEV','IND'])patchRaw(p,id,(raw,e)=>{raw.assertions.find(a=>a.id==='risk:projection-length').objects.reverse();e.assertions.find(a=>a.id==='risk:projection-length').objects.reverse();});},multi);
run('reviewed-contract-change-needs-fresh-proof','reject',p=>{patchRegistry(p,r=>{r.records.find(x=>x.dimension==='anomaly').objects=['field:ledger.id'];const path=join(p,r.coverageBasis.path),b=read(path);b.records.find(x=>x.dimension==='anomaly').objects=['field:ledger.id'];write(path,b);r.coverageBasis.sha256=sha(readFileSync(path));r.coverageBasis.semanticSha256=fixtureBasisDigest(b);});},multi);
const renewed=createLedgerFixture(join(root,'renewed'),{objects:['field:ledger.original','field:ledger.projected'],targetVersion:'review-20261107-renewed'}).base;
run('reviewed-new-contract-and-new-executions','READY_FOR_FINAL_SCOPE',()=>{},renewed);
run('developer-test-local-plus-real-synthetic-review','READY_FOR_FINAL_SCOPE',p=>{const args=[join(p,'docs/producer.mjs'),p,'developer-test',join(p,'docs/run-spec.json')],out=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(out.status,0,out.stderr);const r=read(join(p,'registry.json')),raw=read(join(p,'docs/developer-test-results.json')),env={protocol:2,evidenceProfile:PROFILE,target:r.target,kind:raw.kind,result:raw.result,executedAt:raw.executedAt,snapshot:raw.snapshot,observations:raw.observations,run:{...raw.execution,results:{path:'docs/developer-test-results.json',sha256:sha(readFileSync(join(p,'docs/developer-test-results.json')))}},assertions:raw.assertions};write(join(p,'docs/unit.json'),env);r.evidence.push({id:'UNIT',path:'docs/unit.json',sha256:sha(readFileSync(join(p,'docs/unit.json'))),kind:'developer-test',result:'passed',scope:r.target.id,usage:'active'});for(const x of r.records)x.evidence=['UNIT'];write(join(p,'registry.json'),r);});

return {results};}
