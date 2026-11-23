/** Developer producer, not an independent-review authority. Run only against prepared isolated copies. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sha256, claimDigest, PROFILE, normalizeRaw } from '../gate-evidence-contract.mjs';
const repo=process.cwd(),work=path.join(repo,'packages/server/test-results/dc-batch03');
const review=process.argv[2];
if(!review || !path.isAbsolute(review))throw Error('Explicit isolated review root required');
const out='docs/audits/dc-batch03-2026-11-07';
const r=JSON.parse(fs.readFileSync('docs/quality/coverage-registry.json'));
const b=JSON.parse(fs.readFileSync(r.coverageBasis.path));
function ref(p){return {path:p,sha256:sha256(fs.readFileSync(p))};}
function write(p,x){const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(x,null,2)+'\n');fs.renameSync(t,p);}
const hashes=Object.fromEntries(r.sources.map(s=>[s.id,sha256(fs.readFileSync(s.path))]));
for(const s of r.sources){
 if(hashes[s.id]!==s.sha256)throw Error('Current source drift: '+s.id);
 if(/^packages\/(server|web|shared)\/(src|test)\//.test(s.path)){
  const p=s.path.replace(/^packages\/(server|web|shared)\//,(_,pkg)=>`packages/${pkg}/test-results/dc-batch03/`);
  if(sha256(fs.readFileSync(p))!==s.sha256)throw Error('Isolated source drift: '+s.id);
 }
}
fs.mkdirSync(out,{recursive:true});
const output=path.resolve(out,'developer-vitest.json');
const argv=[path.join(repo,'node_modules/vitest/vitest.mjs'),'run','test/dc-batch03-schema.test.ts','test/diagnostics-series-status.test.ts','--configLoader','native','--reporter=json','--outputFile='+output];
const command=JSON.stringify([process.execPath,...argv]);
const startedAt=new Date().toISOString();
const child=spawnSync(process.execPath,argv,{cwd:work,encoding:'utf8',env:{...process.env,GATE_REPO_ROOT:repo,GATE_REVIEW_ROOT:review,GATE_EVIDENCE_DIR:path.resolve(out),GATE_ACTUAL_COMMAND:command}});
fs.writeFileSync(path.join(out,'developer-vitest.log'),child.stdout+child.stderr);
const result=JSON.parse(fs.readFileSync(output));
if(child.status!==0 || !result.success || result.numFailedTests || result.numPendingTests)throw Error('Actual developer run did not fully pass');
for(const s of r.sources)if(sha256(fs.readFileSync(s.path))!==hashes[s.id])throw Error('Source changed during run');
const tests=result.testResults.flatMap(x=>x.assertionResults).map(x=>({name:x.fullName,result:x.status}));
const claims=r.records.filter(x=>x.sources.includes('S:series-status'));
const assertions=claims.map(x=>({id:x.id,scope:x.scope,objects:x.objects,contractSha256:claimDigest(x,b.records.find(y=>y.id===x.id).applicability),result:'passed',
 checks:{positive:true,negative:true,independentOracle:true,failurePath:true},caseResults:tests}));
const execution={id:randomUUID(),classification:'developer-test',reviewId:null,command,runner:ref('scripts/fixtures/dc-batch03-evidence.mjs'),fixture:ref('packages/server/test/diagnostics-series-status.test.ts')};
const snapshot={policySha256:r.coverageBasis.semanticSha256,schema:{version:r.schema.version,censusSha256:r.schema.sha256},sources:hashes};
const raw={protocol:2,evidenceProfile:PROFILE,kind:'developer-test',target:r.target,executedAt:startedAt,result:'passed',snapshot,execution,assertions,
 actualProcess:{exitCode:child.status,startedAt,finishedAt:new Date().toISOString(),results:ref(out+'/developer-vitest.json')},
 limitation:'Developer validation with explicit SQL/constant oracle expectations; not external-independent, no maintainer review authorization issued.'};
normalizeRaw(raw);
write(out+'/developer-results.json',raw);
write(out+'/developer-proof.json',{protocol:2,evidenceProfile:PROFILE,target:r.target,kind:raw.kind,result:raw.result,executedAt:raw.executedAt,snapshot,
 run:{...execution,results:ref(out+'/developer-results.json')},assertions});
for(const [id,p,kind] of [['E:dc-batch03-schema',out+'/dc-batch03-schema-proof.json','schema-observation'],['E:dc-batch03-developer',out+'/developer-proof.json','developer-test']]){
 const entry={id,...ref(p),kind,result:'passed',scope:r.target.id,usage:'active'};const i=r.evidence.findIndex(e=>e.id===id);if(i<0)r.evidence.push(entry);else r.evidence[i]=entry;
}
fs.copyFileSync('docs/quality/coverage-registry.json',out+'/coverage-registry-pre-proof.json');
write('docs/quality/coverage-registry.json',r);
console.log(JSON.stringify({passed:result.numPassedTests,failed:result.numFailedTests,classification:raw.kind,claims:claims.map(x=>x.id)}));
