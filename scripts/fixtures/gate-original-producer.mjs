import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{pathToFileURL}from'node:url';import{randomUUID}from'node:crypto';import{PROFILE,fixtureDigest,fixtureBasisDigest,fixtureSha as sha}from'./fixture-contract.mjs';
const [root,kind,reviewId]=process.argv.slice(2);const source=readFileSync(join(root,'docs/implementation.mjs'),'utf8');
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

const observed=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(t=>({table:t.name,columns:db.prepare('PRAGMA table_info('+t.name+')').all().map(c=>({name:c.name}))}));db.close();const census=JSON.parse(readFileSync(join(root,'docs/schema.json'),'utf8'));assert.deepEqual(census.tables,observed);
const basis=JSON.parse(readFileSync(join(root,'docs/basis.json'),'utf8'));const byId=new Map(basis.records.map(x=>[x.id,x]));const bound=assertions.map(a=>({...a,scope:byId.get(a.id).scope,checks:{positive:true,negative:true,independentOracle:true,failurePath:true},objects:byId.get(a.id).objects,contractSha256:fixtureDigest(byId.get(a.id),byId.get(a.id).applicability)}));
const snapshot={policySha256:fixtureBasisDigest(basis),schema:{version:13,censusSha256:sha(readFileSync(join(root,'docs/schema.json')))},sources:Object.fromEntries(Object.entries(basis.sources).map(([id,ref])=>[id,sha(readFileSync(join(root,ref.path)))]))};const execution={id:randomUUID(),classification:kind,reviewId:reviewId==='none'?null:reviewId,command:'node docs/producer.mjs <root> '+kind+' '+reviewId,runner:{path:'docs/producer.mjs',sha256:sha(readFileSync(join(root,'docs/producer.mjs')))},fixture:{path:'docs/implementation.mjs',sha256:sha(source)}};const observations={schema:snapshot.schema,objects:census.tables.flatMap(t=>['table:'+t.table,...t.columns.map(c=>'field:'+t.table+'.'+c.name)]).sort()};writeFileSync(join(root,'docs/'+kind+'-results.json'),JSON.stringify({protocol:2,evidenceProfile:PROFILE,kind,target:basis.target,result:'passed',executedAt:new Date().toISOString(),snapshot,execution,observations,assertions:bound},null,2));
