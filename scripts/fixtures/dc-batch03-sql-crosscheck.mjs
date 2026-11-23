/** Separate developer SQL oracle on new synthetic data; not external-independent acceptance. */
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Explicit isolated output root required');
process.env.BANGUMI_DATA_DIR=fs.mkdtempSync(path.join(root,'sql-crosscheck-'));process.env.NODE_ENV='test';
const dist=path.join(process.cwd(),'packages/server/test-results/dc-batch03/dist');
const load=p=>import(pathToFileURL(path.join(dist,p)).href);
const db=await load('db/index.js'),check=await load('db/seriesCollectionStatus.js'),repairs=await load('diagnostics/repair.js');
const facts=await load('diagnostics/sourceProtection.js');const T='2026-11-07T00:00:00.000Z',rows=[];
try{
 db.transaction(()=>{for(let series=1;series<=12;series++){
  db.run(`INSERT INTO series_entities(id,key,title,status_counts,member_count,collected_count,created_at,updated_at) VALUES(:series,:key,'SQL oracle','{}',5,4,:t,:t)`,{series,key:'sr_oracle_'+series,t:T});
  for(let member=1;member<=5;member++){
   const id=series*10+member,type=(series+member)%5+1;
   if(member!==5){db.run('INSERT INTO subjects(id,name,created_at,updated_at) VALUES(:id,\'SQL member\',:t,:t)',{id,t:T});
    db.run('INSERT INTO collections(subject_id,type,first_seen_at,synced_at) VALUES(:id,:type,:t,:t)',{id,type,t:T});}
   db.run("INSERT INTO series_entity_members(series_id,subject_id,role) VALUES(:series,:id,'primary')",{series,id});
  }
 }});
 const initial=check.inspectSeriesCollectionStatus();assert.equal(initial.driftCount,12);assert.equal(initial.blockedCount,0);
 const protectedBefore=facts.captureProtectedSources();
 for(let series=1;series<=12;series++){
  // Deliberately independent SQL GROUP BY, not the production scanner or engine.
  const grouped=db.all(`SELECT c.type,COUNT(*) n FROM series_entity_members m JOIN collections c ON c.subject_id=m.subject_id WHERE m.series_id=:series AND m.role='primary' GROUP BY c.type ORDER BY c.type`,{series});
  const expected=Object.fromEntries(grouped.map(r=>[String(r.type),r.n]));const key='sr_oracle_'+series;
  const plan=check.inspectSeriesCollectionStatus(key).plans[0];assert.deepEqual(plan.expected,expected);
  const result=repairs.runDiagnosticsRepair({issueId:check.STATUS_DRIFT,kind:'recompute-derived',target:key,value:plan.token});assert.equal(result.ok,true);
  const stored=db.one('SELECT status_counts FROM series_entities WHERE key=:key',{key});assert.deepEqual(JSON.parse(stored.status_counts),expected);
  rows.push({series,key,expected,verified:result.ok});
 }
 assert.equal(check.inspectSeriesCollectionStatus().driftCount,0);assert.deepEqual(facts.captureProtectedSources(),protectedBefore);
 fs.writeFileSync(path.join(root,'sql-crosscheck-results.json'),JSON.stringify({classification:'developer-cross-check',oracle:'independent SQL GROUP BY on new synthetic fixture; not external reviewer',rows,sourcePreserved:true},null,2));
 console.log('12/12 SQL oracle targets repaired and rechecked; source fingerprints preserved');
}finally{db.closeDatabase();}
