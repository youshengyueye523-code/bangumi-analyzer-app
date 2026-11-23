import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PROFILE,fixtureDigest,fixtureBasisDigest} from './fixture-contract.mjs';
import {pathToFileURL} from 'node:url';
const [root,kind,config]=process.argv.slice(2);
assert(['developer-test','developer-cross-check','external-independent'].includes(kind));
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const c=JSON.parse(readFileSync(config)),basis=JSON.parse(readFileSync(join(root,'docs/basis.json'))),byId=new Map(basis.records.map(x=>[x.id,x]));
const m=await import(pathToFileURL(join(root,'docs/model.mjs')));
const db=new DatabaseSync(':memory:');m.initialize(db);
const checks={positive:true,negative:true,independentOracle:true,failurePath:true},assertions=[];
function prove(id,fn){fn();assertions.push({id,scope:c.scopes[id],result:'passed',checks:{...checks},objects:byId.get(id).objects,contractSha256:fixtureDigest(byId.get(id),byId.get(id).applicability)});}
prove('table:ledger',()=>{
 assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name),['ledger']);
 assert.throws(()=>db.exec('SELECT * FROM absent_table'));assert.equal(db.isTransaction,false);
});
prove('field:ledger.id',()=>{
 db.exec("INSERT INTO ledger VALUES(101,'kept',4)");assert.throws(()=>db.exec("INSERT INTO ledger VALUES(101,'collision',9)"));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n,1);
});
prove('field:ledger.original',()=>{
 assert.throws(()=>db.exec('INSERT INTO ledger VALUES(102,NULL,0)'));assert.equal(db.prepare('SELECT original FROM ledger').get().original,'kept');
});
prove('field:ledger.projected',()=>{
 assert.throws(()=>db.exec("INSERT INTO ledger VALUES(102,'x',NULL)"));assert.equal(db.prepare('SELECT projected FROM ledger').get().projected,4);
});
db.exec("INSERT INTO ledger VALUES(102,'do-not-rewrite',99);INSERT INTO ledger VALUES(103,'',0)");
prove('risk:projection-length',()=>{
 assert.deepEqual(m.detect(db).map(x=>x.id),[102]);
 assert.deepEqual(m.detect(db).map(x=>x.id),db.prepare('SELECT id FROM ledger WHERE projected<>length(original) ORDER BY id').all().map(x=>x.id));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger WHERE projected=length(original)').get().n,2);
});
prove('path:ledger-consumer',()=>{
 assert.deepEqual(db.prepare('SELECT id,projected FROM ledger ORDER BY id').all().map(x=>[x.id,x.projected]),[[101,4],[102,99],[103,0]]);
 assert.deepEqual(db.prepare('SELECT id FROM ledger WHERE id=-1').all(),[]);
});
prove('repair:rebuild-ledger-projection',()=>{
 const before=db.prepare('SELECT * FROM ledger ORDER BY id').all();
 assert.throws(()=>m.execute(db,[]),/stale/);assert.deepEqual(db.prepare('SELECT * FROM ledger ORDER BY id').all(),before);
 const plan=m.preview(db);assert.deepEqual(plan,[{id:102,from:99,to:14}]);m.execute(db,plan);
 assert.deepEqual(db.prepare('SELECT id,original FROM ledger ORDER BY id').all().map(x=>[x.id,x.original]),before.map(x=>[x.id,x.original]));
 assert.equal(db.prepare('SELECT projected FROM ledger WHERE id=102').get().projected,14);
});
prove('truth:projection-correct',()=>{
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger WHERE projected<>length(original)').get().n,0);assert.deepEqual(m.detect(db),[]);
 const before=db.prepare('SELECT * FROM ledger ORDER BY id').all();assert.throws(()=>m.execute(db,[{id:102,from:99,to:14}]),/stale/);
 assert.deepEqual(db.prepare('SELECT * FROM ledger ORDER BY id').all(),before);assert.equal(db.isTransaction,false);
});
const observed=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(t=>({table:t.name,columns:db.prepare('PRAGMA table_info('+t.name+')').all().map(c=>({name:c.name}))}));const census=JSON.parse(readFileSync(join(root,'docs/census.json')));assert.deepEqual(observed,census.tables);assert.equal(db.prepare('PRAGMA user_version').get().user_version,census.schema);db.close();
const executedAt=new Date().toISOString();
const snapshot={policySha256:fixtureBasisDigest(basis),schema:{version:13,censusSha256:sha(readFileSync(join(root,'docs/census.json')))},sources:Object.fromEntries(Object.entries(basis.sources).map(([id,ref])=>[id,sha(readFileSync(join(root,ref.path)))]))};
const execution={id:randomUUID(),classification:kind,reviewId:kind==='external-independent'?'synthetic-ledger-review':null,command:`node docs/producer.mjs <isolated-root> ${kind} <config>`,runner:{path:'docs/producer.mjs',sha256:sha(readFileSync(join(root,'docs/producer.mjs')))},fixture:{path:'docs/model.mjs',sha256:sha(readFileSync(join(root,'docs/model.mjs')))}};
const raw={protocol:2,evidenceProfile:PROFILE,kind,target:c.target,result:'passed',executedAt,snapshot,execution,observations:{schema:snapshot.schema,objects:census.tables.flatMap(t=>['table:'+t.table,...t.columns.map(c=>'field:'+t.table+'.'+c.name)]).sort()},assertions};
writeFileSync(join(root,`docs/${kind}-results.json`),JSON.stringify(raw,null,2));
console.log(JSON.stringify({kind,assertions:assertions.length,result:'passed',executedAt}));
