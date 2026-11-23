/** Copy into an isolated server/test; its setup creates a fresh temporary DB. */
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {all,schemaVersion} from '../src/db/index.js';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex').toUpperCase();
it('Fresh isolated census, explicit source role/run identity and exact object-set contract',async()=>{
 const repo=process.env.GATE_REPO_ROOT!,review=process.env.GATE_REVIEW_ROOT!,out=process.env.GATE_EVIDENCE_DIR!;
 expect(process.env.BANGUMI_DATA_DIR).toContain('bangumi-analyzer-test-');
 const r=JSON.parse(readFileSync(join(repo,'docs/quality/coverage-registry.json'),'utf8'));
 const helpers=await import(pathToFileURL(join(repo,'scripts/gate-evidence-contract.mjs')).href);
 const tables=all<{name:string}>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name");
 const observed={schema:schemaVersion(),tables:tables.map(t=>({table:t.name,columns:all<any>(`PRAGMA table_info("${t.name}")`).map(c=>({name:c.name,type:c.type,notnull:c.notnull,pk:c.pk}))}))};
 const bytes=readFileSync(join(repo,r.schema.path));expect(observed).toEqual(JSON.parse(bytes.toString('utf8')));
 const sources=Object.fromEntries(r.schema.ownerSources.map((id:string)=>{const s=r.sources.find((x:any)=>x.id===id),actual=sha(readFileSync(join(review,s.path)));expect(actual).toBe(s.sha256);return [id,actual];}));
 const schema={version:observed.schema,censusSha256:sha(bytes)},objects=helpers.ids(observed.tables.flatMap(t=>['table:'+t.table,...t.columns.map(c=>'field:'+t.table+'.'+c.name)]));
 const snapshot={policySha256:r.coverageBasis.semanticSha256,schema,sources};
 const runner='scripts/fixtures/gate-schema-producer.test.ts',kind='schema-observation',executedAt=new Date().toISOString();
 expect(sha(readFileSync(join(review,'packages/server/test/gate-origin-schema.test.ts')))).toBe(sha(readFileSync(join(repo,runner))));
 const execution={id:randomUUID(),classification:kind,reviewId:null,command:'Node24 Vitest gate-origin-schema.test.ts --config isolated/server.config.ts --configLoader runner',runner:{path:runner,sha256:sha(readFileSync(join(repo,runner)))},fixture:{path:r.schema.path,sha256:sha(bytes)}};
 const observations={schema,objects},assertions=[{id:'schema:census',scope:'schema-inventory',result:'passed',objects,contractSha256:helpers.schemaDigest(schema,objects)}];
 const raw={protocol:2,evidenceProfile:helpers.PROFILE,kind,target:r.target,executedAt,result:'passed',snapshot,execution,observations,assertions},rawBytes=JSON.stringify(raw,null,2);
 const envelope={protocol:2,evidenceProfile:helpers.PROFILE,target:r.target,kind,result:'passed',executedAt,snapshot,observations,run:{...execution,results:{path:'docs/quality/schema-evidence-chain-results-v2.json',sha256:sha(rawBytes)}},assertions};
 writeFileSync(join(out,'schema-evidence-chain-results-v2.json'),rawBytes);writeFileSync(join(out,'schema-evidence-chain-v2.json'),JSON.stringify(envelope,null,2));
});
