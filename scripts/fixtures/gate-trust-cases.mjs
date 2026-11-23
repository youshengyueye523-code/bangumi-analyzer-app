import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {PROFILE,copyFixtureCodec,witnessFixture,fixtureBasisDigest} from './gate-witness-fixture.mjs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export async function runGateCases(A,evaluateGate){
const sha=s=>createHash('sha256').update(s).digest('hex').toUpperCase();
const root=join(A,'gate-synthetic');mkdirSync(join(root,'docs'),{recursive:true});
const source=[
'export function init(db){db.exec("CREATE TABLE review_values(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);PRAGMA user_version=13");}',
'export function valid(x){return typeof x==="number" && x>=0;}',
'export function consumer(db){return db.prepare("SELECT id,value FROM review_values ORDER BY id").all();}',
'export function preview(db){return consumer(db).filter(r=>!valid(r.value));}',
'export function repair(db,plan){',
' db.exec("BEGIN");try{',
' const actual=preview(db);if(JSON.stringify(actual)!==JSON.stringify(plan))throw Error("stale-plan");',
' for(const r of plan)db.prepare("UPDATE review_values SET value=0 WHERE id=?").run(r.id);',
' if(preview(db).length)throw Error("verify-failed");db.exec("COMMIT");',
' }catch(e){db.exec("ROLLBACK");throw e;}',
'}'].join('\n');
writeFileSync(join(root,'docs/implementation.mjs'),source);
const {DatabaseSync}=await import('node:sqlite');
const impl=await import(pathToFileURL(join(root,'docs/implementation.mjs')).href+'?'+Date.now()),db=new DatabaseSync(':memory:');
const assertions=[];
function prove(id,fn){fn();assertions.push({id,result:'passed'});}
impl.init(db);
prove('table:review_values',()=>assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name),['review_values']));
prove('field:review_values.id',()=>assert.equal(db.prepare('PRAGMA table_info(review_values)').all()[0].pk,1));
prove('field:review_values.value',()=>assert.equal(db.prepare('PRAGMA table_info(review_values)').all()[1].notnull,1));
db.prepare('INSERT INTO review_values VALUES(?,?)').run(1,3);db.prepare('INSERT INTO review_values VALUES(?,?)').run(2,-4);
prove('risk:nonnegative',()=>{assert.equal(impl.valid(3),true);assert.equal(impl.valid(-4),false);assert.equal(impl.valid('3'),false);assert.deepEqual(impl.preview(db).map(x=>x.id),db.prepare('SELECT id FROM review_values WHERE value<0 ORDER BY id').all().map(x=>x.id));});
prove('path:synthetic-consumer',()=>assert.deepEqual(impl.consumer(db).map(x=>x.value),[3,-4]));
prove('repair:synthetic-repair',()=>{const before=impl.consumer(db);assert.throws(()=>impl.repair(db,[]),/stale-plan/);assert.deepEqual(impl.consumer(db),before);const plan=impl.preview(db);assert.deepEqual(plan.map(x=>x.id),[2]);impl.repair(db,plan);assert.deepEqual(impl.consumer(db).map(x=>x.value),[3,0]);});
prove('risk:critical-history',()=>assert.equal(db.prepare('SELECT value FROM review_values WHERE id=1').get().value,3));
prove('truth:nonnegative',()=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM review_values WHERE value<0').get().n,0);assert.deepEqual(impl.preview(db),[]);});
const proof={kind:'external-independent',scope:'ISOLATED_SYNTHETIC_ONLY',result:'passed',command:'Node24 gate-independent.mjs',fixture:'in-memory SQLite schema13 + implementation/consumer/preview/execute/verify + stale-plan rollback',assertions,sourceSha256:sha(source),positive:true,negative:true,failurePath:true,executedAt:new Date().toISOString()};
const observedSchema=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(t=>({table:t.name,columns:db.prepare('PRAGMA table_info('+t.name+')').all().map(c=>({name:c.name}))}));db.close();
writeFileSync(join(root,'docs/proof.json'),JSON.stringify(proof,null,2));
const census={schema:13,tables:observedSchema};const contract="export const DIAGNOSTIC_REPAIR_KINDS = ['synthetic-repair']; export const FRANCHISE_GOVERNANCE_KINDS = [];";
writeFileSync(join(root,'docs/schema.json'),JSON.stringify(census));writeFileSync(join(root,'docs/contract.ts'),contract);
const base={scope:'ISOLATED_SYNTHETIC_ONLY',residual:'No product or release claim',owner:'independent reviewer',matrix:['SYNTHETIC'],sources:['S'],evidence:['E'],validation:{positive:true,negative:true,independentOracle:true,failurePath:true}};
const records=['table:review_values','field:review_values.id','field:review_values.value','risk:nonnegative','risk:critical-history','path:synthetic-consumer','repair:synthetic-repair','truth:nonnegative'].map(id=>({...structuredClone(base),id,dimension:id.startsWith('table:')||id.startsWith('field:')?'data':id.startsWith('risk:')?'anomaly':id.split(':')[0],priority:id.startsWith('repair:')?'P0':'P1',status:'verified',...(id.startsWith('risk:')?Object.fromEntries(['invariant','proof','origin','detection','trigger','locateExplain','handling','human','falsePositive','falseNegative','samples'].map(k=>[k,'explicit bounded synthetic '+k])):{})}));
const original={version:1,schema:{version:13,path:'docs/schema.json',sha256:sha(JSON.stringify(census)),ownerSource:'S'},repairCatalogue:{path:'docs/contract.ts',sha256:sha(contract)},sources:[{id:'S',path:'docs/implementation.mjs',sha256:sha(source)}],evidence:[{id:'E',path:'docs/proof.json',sha256:sha(readFileSync(join(root,'docs/proof.json'))),kind:'external-independent',result:'passed',scope:'ISOLATED_SYNTHETIC_ONLY',sourceSha256:sha(source)}],finalIndependentEvidence:['E'],records};

for(const x of records){x.objects=x.id.startsWith('field:')?['table:review_values']:x.id.startsWith('risk:')||x.id.startsWith('path:')||x.id.startsWith('repair:')||x.id.startsWith('truth:')?['field:review_values.id','field:review_values.value']:[];}
const target={id:proof.scope,version:'synthetic-contract-1'};
copyFixtureCodec(root);for(const x of records)x.sources.push('CODEC');
const basis={version:1,evidenceProfile:PROFILE,target,repairCatalogue:structuredClone(original.repairCatalogue),schema:{version:13,censusSha256:original.schema.sha256,ownerSources:['S']},sources:{S:{path:'docs/implementation.mjs',sha256:sha(source)},CODEC:{path:'docs/codec.mjs',sha256:sha(readFileSync(join(root,'docs/codec.mjs')))}},records:records.map(x=>({id:x.id,dimension:x.dimension,priority:x.priority,scope:x.scope,sources:x.sources,objects:x.objects,applicability:'required',...Object.fromEntries(['invariant','detection','handling','safeHandling'].filter(k=>x[k]!=null).map(k=>[k,x[k]]))}))};
const policyBytes=JSON.stringify(basis,null,2);writeFileSync(join(root,'docs/basis.json'),policyBytes);
cpSync(fileURLToPath(new URL('./gate-original-producer.mjs',import.meta.url)),join(root,'docs/producer.mjs'));copyFixtureCodec(root);
const completed=[];for(const kind of ['developer-cross-check','external-independent']){const argv=[join(root,'docs/producer.mjs'),root,kind,kind==='external-independent'?'synthetic-original-review':'none'];const run=spawnSync(process.execPath,argv,{encoding:'utf8',windowsHide:true});completed.push({exitCode:run.status,argv:[process.execPath,...argv],stderr:run.stderr});assert.equal(run.status,0,run.stderr);}
const raw=JSON.parse(readFileSync(join(root,'docs/external-independent-results.json'),'utf8'));const envelope={protocol:2,evidenceProfile:PROFILE,target,kind:raw.kind,result:raw.result,executedAt:raw.executedAt,snapshot:raw.snapshot,observations:raw.observations,run:{...raw.execution,results:{path:'docs/external-independent-results.json',sha256:sha(readFileSync(join(root,'docs/external-independent-results.json')))}},assertions:raw.assertions};writeFileSync(join(root,'docs/proof.json'),JSON.stringify(envelope,null,2));witnessFixture(root,'docs/proof.json','docs/developer-cross-check-results.json',completed[1]);writeFileSync(join(root,'docs/producer-executions.json'),JSON.stringify(completed,null,2));
original.sources.push({id:'CODEC',...basis.sources.CODEC});
Object.assign(original,{version:2,evidenceProfile:PROFILE,target,coverageBasis:{path:'docs/basis.json',sha256:sha(policyBytes),semanticSha256:fixtureBasisDigest(basis)}});original.schema.ownerSources=['S'];original.schema.generationEvidence='E';original.evidence[0].usage='active';original.evidence[0].sha256=sha(readFileSync(join(root,'docs/proof.json')));
const results=[];
function check(name,expected,mutate=()=>{}){
 const r=structuredClone(original);writeFileSync(join(root,'docs/implementation.mjs'),source);mutate(r);
 const caseRoot=join(root,'cases',name);mkdirSync(caseRoot,{recursive:true});cpSync(join(root,'docs'),join(caseRoot,'docs'),{recursive:true});const reg=join(caseRoot,'registry.json');writeFileSync(reg,JSON.stringify(r,null,2));let actual;
 try{actual=evaluateGate(reg,caseRoot);}catch(e){actual={status:'THREW',error:e.message};}
 const pass=expected==='reject'?['INVALID','NOT_READY'].includes(actual.status):actual.status===expected;
  let runtimeProbe;
 if(['stale-proof-refreshed-source','schema-source-added-unregistered-table'].includes(name)){
  const bytes=readFileSync(join(caseRoot,'docs/implementation.mjs'),'utf8');
  const model=new Function(bytes.replaceAll('export ','')+';return {init,valid};')(),d=new DatabaseSync(':memory:');model.init(d);
  runtimeProbe={validPositive:model.valid(3),validNegative:model.valid(-4),actualTables:d.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(x=>x.name)};d.close();
 }
 results.push({name,expected,pass,runtimeProbe,actual});console.log((pass?'PASS ':'FAIL ')+name+' -> '+actual.status);
}
check('valid-complete-synthetic','READY_FOR_FINAL_SCOPE');
for(const status of ['unknown','partial','uncovered'])check('critical-'+status,'reject',r=>{r.records[0].status=status;});
check('no-evidence','reject',r=>{r.records[0].evidence=[];});
check('failed-test','reject',r=>{r.evidence[0].result='failed';});
check('missing-external-review','reject',r=>{r.finalIndependentEvidence=[];});
check('missing-na-reason','reject',r=>{r.records[0].status='not-applicable';});
check('missing-column-in-census','reject',r=>{r.records=r.records.filter(x=>x.id!=='field:review_values.value');});
check('new-census-column','reject',r=>{const c=structuredClone(census);c.tables[0].columns.push({name:'future'});writeFileSync(join(root,'docs/new-schema.json'),JSON.stringify(c));r.schema.path='docs/new-schema.json';r.schema.sha256=sha(JSON.stringify(c));});
check('changed-source-unrefreshed','reject',r=>{writeFileSync(join(root,'docs/implementation.mjs'),source+'\n// changed');});
check('unsupported-verified-flags','reject',r=>{r.records[0].validation.negative=false;});
check('p2-no-approval','reject',r=>{r.records[0].priority='P2';r.records[0].status='partial';});
check('unknown-stays-denominator','NOT_READY',r=>{r.records[0].status='unknown';});
check('stale-proof-refreshed-source','reject',r=>{const changed=source.replace('x>=0','x<0');writeFileSync(join(root,'docs/implementation.mjs'),changed);r.sources[0].sha256=sha(changed);});
check('supported-p0-repair-na-without-tests','reject',r=>{const x=r.records.find(x=>x.dimension==='repair');x.status='not-applicable';x.notApplicableReason='not run this time';x.evidence=[];delete x.validation;});
check('critical-anomaly-removed','reject',r=>{r.records=r.records.filter(x=>x.id!=='risk:critical-history');});
check('wrong-dimension-removes-critical-denominator','reject',r=>{r.records[0].dimension='truth';});
check('truthy-string-not-validation','reject',r=>{for(const x of r.records)x.validation={positive:'false',negative:'false',independentOracle:'false',failurePath:'false'};});
check('external-proof-unrelated-scope','reject',r=>{r.evidence[0].scope='different-slice';r.evidence[0].kind='developer-cross-check';r.evidence.push({...r.evidence[0],id:'UNRELATED',kind:'external-independent',scope:'unrelated'});r.finalIndependentEvidence=['UNRELATED'];});
check('schema-source-added-unregistered-table','reject',r=>{const changed=source.replace('PRAGMA user_version=13','CREATE TABLE new_critical_source(id INTEGER);PRAGMA user_version=13');writeFileSync(join(root,'docs/implementation.mjs'),changed);r.sources[0].sha256=sha(changed);});
writeFileSync(join(root,'docs/implementation.mjs'),source);

function changeProof(r,fn){const p=JSON.parse(readFileSync(join(root,'docs/proof.json'),'utf8'));fn(p);const bytes=JSON.stringify(p,null,2);writeFileSync(join(root,'docs/proof.json'),bytes);r.evidence[0].sha256=sha(bytes);}
// Original cases change only implementation; reset baseline envelope for each additional experiment.
const baseProof=JSON.stringify(envelope,null,2),basePolicy=JSON.stringify(basis,null,2);function extra(name,mutate){writeFileSync(join(root,'docs/proof.json'),baseProof);writeFileSync(join(root,'docs/basis.json'),basePolicy);check(name,'reject',mutate);}
extra('evidence-target-version-tampered',r=>changeProof(r,p=>p.target.version='other-version'));
extra('evidence-claim-scope-tampered',r=>changeProof(r,p=>p.assertions[0].scope='other-module'));
extra('evidence-expired',r=>changeProof(r,p=>p.expiresAt='2020-01-01T00:00:00.000Z'));
extra('evidence-result-unverifiable',r=>changeProof(r,p=>p.run.results.sha256='F'.repeat(64)));
extra('refreshed-policy-still-cannot-refresh-old-source-proof',r=>{const changed=source.replace('x>=0','x<0');writeFileSync(join(root,'docs/implementation.mjs'),changed);r.sources[0].sha256=sha(changed);const b=structuredClone(basis);b.sources.S.sha256=sha(changed);const bytes=JSON.stringify(b,null,2);writeFileSync(join(root,'docs/basis.json'),bytes);r.coverageBasis.sha256=sha(bytes);changeProof(r,p=>{p.snapshot.policySha256=sha(bytes);p.run.fixture.sha256=sha(changed);});});

extra('schema-observation-cannot-prove-behavior',r=>{const p=structuredClone(envelope);p.kind='schema-observation';const bytes=JSON.stringify(p,null,2);writeFileSync(join(root,'docs/observation.json'),bytes);r.evidence.push({...r.evidence[0],id:'OBS',kind:p.kind,path:'docs/observation.json',sha256:sha(bytes)});r.records[0].evidence=['OBS'];});
extra('approval-cannot-prove-critical-repair',r=>{const p=structuredClone(envelope);p.kind='risk-acceptance';const bytes=JSON.stringify(p,null,2);writeFileSync(join(root,'docs/approval.json'),bytes);r.evidence.push({...r.evidence[0],id:'APP',kind:p.kind,path:'docs/approval.json',sha256:sha(bytes)});r.records.find(x=>x.dimension==='repair').evidence=['APP'];});

return {proof:envelope,results};
}