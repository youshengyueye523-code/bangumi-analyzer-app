import{readFileSync,writeFileSync,mkdirSync,cpSync}from'node:fs';import{join}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';import assert from'node:assert/strict';import{PROFILE,copyFixtureCodec,fixtureBasisDigest,witnessFixture}from'./gate-witness-fixture.mjs';
export function createLedgerFixture(A,options={}){
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();const read=p=>JSON.parse(readFileSync(p));const write=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2));
const root=A;mkdirSync(join(root,'base/docs'),{recursive:true});const base=join(root,'base');
cpSync(fileURLToPath(new URL('./gate-ledger-model.mjs',import.meta.url)),join(base,'docs/model.mjs'));cpSync(fileURLToPath(new URL('./gate-ledger-producer.mjs',import.meta.url)),join(base,'docs/producer.mjs'));copyFixtureCodec(base);
const ids=['table:ledger','field:ledger.id','field:ledger.original','field:ledger.projected','risk:projection-length','path:ledger-consumer','repair:rebuild-ledger-projection','truth:projection-correct'];
const scopes=Object.fromEntries(ids.map(id=>[id,'independent-ledger/'+id])),target={id:'INDEPENDENT_LEDGER_ONLY',version:options.targetVersion??'review-20261107-1'};
const dimension=id=>id.startsWith('table:')||id.startsWith('field:')?'data':id.startsWith('risk:')?'anomaly':id.split(':')[0];
const census={schema:13,tables:[{table:'ledger',columns:['id','original','projected'].map(name=>({name}))}]};write(join(base,'docs/census.json'),census);
writeFileSync(join(base,'docs/contract.ts'),"export const DIAGNOSTIC_REPAIR_KINDS = ['rebuild-ledger-projection'];export const FRANCHISE_GOVERNANCE_KINDS = [];");
const ref=path=>({path,sha256:sha(readFileSync(join(base,path)))});
const records=ids.map(id=>({id,dimension:dimension(id),priority:id.startsWith('repair:')?'P0':'P1',scope:scopes[id],status:'verified',owner:'new isolated review',residual:'Synthetic only; no product truth claim',matrix:['ISOLATED'],sources:['MODEL'],evidence:['DEV'],validation:{positive:true,negative:true,independentOracle:true,failurePath:true},...(id.startsWith('risk:')?Object.fromEntries(['invariant','proof','origin','detection','trigger','locateExplain','handling','human','falsePositive','falseNegative','samples'].map(k=>[k,'bounded ledger '+k])):{})}));
for(const x of records)x.objects=[];records.find(x=>x.dimension==='anomaly').objects=options.objects??['field:ledger.projected'];
for(const x of records)x.sources.push('CODEC');
const basis={version:1,evidenceProfile:PROFILE,target,repairCatalogue:ref('docs/contract.ts'),schema:{version:13,censusSha256:ref('docs/census.json').sha256,ownerSources:['MODEL']},sources:{MODEL:ref('docs/model.mjs'),CODEC:ref('docs/codec.mjs')},records:records.map(x=>({id:x.id,dimension:x.dimension,priority:x.priority,scope:x.scope,sources:x.sources,objects:x.objects,applicability:'required',...Object.fromEntries(['invariant','detection','handling','safeHandling'].filter(k=>x[k]!=null).map(k=>[k,x[k]]))}))};write(join(base,'docs/basis.json'),basis);write(join(base,'docs/run-spec.json'),{target,scopes});
const logs=[];
for(const kind of ['developer-cross-check','external-independent']){
 const run=spawnSync(process.execPath,[join(base,'docs/producer.mjs'),base,kind,join(base,'docs/run-spec.json')],{encoding:'utf8'});logs.push({kind,exitCode:run.status,argv:[process.execPath,join(base,'docs/producer.mjs'),base,kind,join(base,'docs/run-spec.json')],stdout:run.stdout,stderr:run.stderr});assert.equal(run.status,0,run.stderr);
 const raw=read(join(base,`docs/${kind}-results.json`));
 write(join(base,`docs/${kind}.json`),{protocol:2,evidenceProfile:PROFILE,target,kind,result:raw.result,executedAt:raw.executedAt,snapshot:raw.snapshot,observations:raw.observations,run:{...raw.execution,results:ref(`docs/${kind}-results.json`)},assertions:raw.assertions});
}
write(join(root,'producer-runs.json'),logs);
const r={version:2,evidenceProfile:PROFILE,target,coverageBasis:{...ref('docs/basis.json'),semanticSha256:fixtureBasisDigest(basis)},repairCatalogue:ref('docs/contract.ts'),schema:{version:13,...ref('docs/census.json'),ownerSources:['MODEL'],generationEvidence:'DEV'},sources:[{id:'MODEL',...ref('docs/model.mjs')},{id:'CODEC',...ref('docs/codec.mjs')}],evidence:[['DEV','developer-cross-check'],['IND','external-independent']].map(([id,kind])=>({id,...ref(`docs/${kind}.json`),kind,result:'passed',scope:target.id,usage:'active'})),finalIndependentEvidence:['IND'],records};write(join(base,'registry.json'),r);witnessFixture(base,'docs/external-independent.json','docs/developer-cross-check-results.json',logs[1]);

return {base,logs};
}
