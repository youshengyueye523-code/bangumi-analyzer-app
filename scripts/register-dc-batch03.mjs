import fs from 'node:fs';import path from 'node:path';import {basisDigest,sha256} from './gate-evidence-contract.mjs';
const root=process.cwd(),r=JSON.parse(fs.readFileSync('docs/quality/coverage-registry.json')),b=JSON.parse(fs.readFileSync(r.coverageBasis.path));
const write=(p,x)=>{const t=p+'.dc03.tmp';fs.writeFileSync(t,JSON.stringify(x,null,2)+'\n');fs.renameSync(t,p)};
for(const [id,p] of [['S:series-status','packages/server/src/db/seriesCollectionStatus.ts'],['S:series-status-cases','packages/server/test/diagnostics-series-status.test.ts'],['S:public-copy','packages/server/src/diagnostics/presentationCatalog.ts'],['S:series-status-schema-producer','scripts/fixtures/dc-batch03-schema.test.ts']])if(!r.sources.some(s=>s.id===id))r.sources.push({id,path:p,sha256:sha256(fs.readFileSync(p))});
for(const s of r.sources){s.sha256=sha256(fs.readFileSync(s.path));b.sources[s.id]={path:s.path,sha256:s.sha256};}
const objects=['field:series_entities.status_counts','field:series_entities.state','field:series_entity_members.series_id','field:series_entity_members.subject_id','field:series_entity_members.role','field:collections.type','field:collections.updated_at','field:collections.synced_at','field:subjects.id','field:subjects.nsfw','field:meta.value'];
const sources=['S:series-status','S:series-status-cases','S:detectors','S:repair','S:query','S:db','S:mutation','S:privacy','S:public-copy','S:contract','S:protection','S:report'];
const entries=[
 ['risk:issue:series.collection-status-drift','anomaly','P1','Current local primary membership and valid collection statuses; exact distribution equality, not totals/raw epochs','Sparse/zero-filled counts 1..5 are equivalent; invalid JSON, invalid counts or same-total different bins are drift.','Full streaming Schema13 scan with bounded evidence; report/manual path only.','Existing recompute-derived allowlist; exact target and source/projection/version-bound plan; only rederive status_counts, no identity rebuild.'],
 ['risk:issue:series.collection-status-unassessable','anomaly','P1','Local source/membership ambiguity for status distribution; not remote authenticity','Illegal collection state or duplicate live primary membership must not yield a healthy distribution.','Full streaming source joins; uncollected/relation-only are legal, not guessed wish.','Manual/reliable source governance, reject forced repair; no source edits.'],
 ['path:series-collection-status','path','P1','Membership/collection -> materialized Series status_counts -> list/detail/watch -> HTTP/Web status labels','Series status distribution equals the grouping of current collected primary members, with Real/Visible separate.','Existing report refresh; ingress/start keep existing recompute/mutation, no new triggers.','Exact target rederive -> mutation -> full rescan + real target consumer Verify; B1 disclosure unchanged.'],
 ['truth:series-collection-status-repair','truth','P0','Target repair result only; no all-domain health or independent acceptance','No verified success unless target projection, API/visibility and protected source checks all pass; exceptions roll back.','Source/projection/version token matching, false-check partial and thrown Verify rollback.','Unavailable trustworthy source yields needs-review and no action; no paid requests or external sync.']
];
for(const [id,dimension,priority,scope,invariant,detection,handling] of entries){if(r.records.some(x=>x.id===id))continue;const x={id,dimension,priority,scope,status:'partial',owner:'data-quality-maintainer',matrix:['Q05','Q08','Q06','Q10'],sources,objects,invariant,detection,handling,evidence:[],residual:'DC-BATCH-03 developer validation only; new independent acceptance pending. No remote truth, all aggregates, arbitrary scale or entire existing repair action proved.'};r.records.push(x);b.records.push({id,dimension,priority,scope,sources,objects,invariant,detection,handling,applicability:'required'});}
for(const x of r.records.filter(x=>entries.some(e=>e[0]===x.id)))x.evidence=['E:dc-batch03-developer'];
for(const x of r.records.filter(x=>entries.some(e=>e[0]===x.id)&&x.dimension==='anomaly'))Object.assign(x,{
 proof:'Exact current-local invariant; developer SQL/constant oracle cases, not external-independent acceptance',
 origin:'Current-source blind spot reproduced in isolated frozen pre-batch03 implementation; synthetic cases, not a claim about real user DB',
 trigger:'Existing registered report/manual refresh; ingress/start retain existing recompute/mutation and are not full scans',
 locateExplain:'Bounded key/member/source-state and timestamp samples; raw snapshots are not equated across epochs; B1 redacts evidence by default',
 human:'No source, member, manual title, candidate decision, exclusion or history edits; ambiguous source remains manual-review',
 falsePositive:'Sparse/zero-filled/order-equivalent counts, older raw, uncollected, relation-only, candidates and stale entities are lawful',
 falseNegative:'Only current local primary collection-status distribution; not remote truth, all derived fields, external-write freshness or arbitrary future schemas',
 samples:['packages/server/test/diagnostics-series-status.test.ts: SC01-SC16; exact execution results in developer-vitest.json']
});
// Preserve every existing unit/status/priority/object contract. New slice has its own bounded claims.
b.origin={...b.origin,dcBatch03:'2026-11-07 append-only new status-distribution claims; old snapshots retained in sealed batch03 before/'};
write(r.coverageBasis.path,b);r.coverageBasis.sha256=sha256(fs.readFileSync(r.coverageBasis.path));r.coverageBasis.semanticSha256=basisDigest(b);
// Prior schema observation remains historical; a new observation is required for the new policy snapshot.
for(const e of r.evidence)if(e.id==='E:schema-evidence-chain')e.usage='historical';
r.schema.generationEvidence='E:dc-batch03-schema';r.date='2026-11-07';
write('docs/quality/coverage-registry.json',r);
console.log(JSON.stringify({records:r.records.length,sources:r.sources.length,newClaims:entries.map(x=>x[0]),needsNewSchemaObservation:true}));
