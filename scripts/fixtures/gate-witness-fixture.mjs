/** Test-only custodian. Shared wire codec; business assertions remain in actual producers. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROFILE,claimContract as fixtureContract,claimDigest as fixtureDigest,basisDigest as fixtureBasisDigest,resultDigest as fixtureResultDigest,sha256 as fixtureSha} from '../gate-evidence-contract.mjs';
export {PROFILE,fixtureContract,fixtureDigest,fixtureBasisDigest,fixtureResultDigest,fixtureSha};
export function copyFixtureCodec(root){
 mkdirSync(join(root,'docs'),{recursive:true});
 writeFileSync(join(root,'docs/fixture-contract.mjs'),readFileSync(fileURLToPath(import.meta.url),'utf8').replaceAll("'../gate-evidence-contract.mjs'","'./codec.mjs'"));
 copyFileSync(fileURLToPath(new URL('../gate-evidence-contract.mjs',import.meta.url)),join(root,'docs/codec.mjs'));
}
export function witnessFixture(root,envelopePath,developerRawPath,completedProcess){
 const read=p=>JSON.parse(readFileSync(join(root,p),'utf8')),ref=p=>({path:p,sha256:fixtureSha(readFileSync(join(root,p)))}),p=read(envelopePath),raw=read(p.run.results.path),dev=read(developerRawPath);
 assert(['ISOLATED_SYNTHETIC_ONLY','INDEPENDENT_LEDGER_ONLY'].includes(p.target.id),'Never issue project credentials');
 assert.equal(completedProcess.exitCode,0);assert.equal(raw.kind,'external-independent');assert.equal(dev.kind,'developer-cross-check');assert.notEqual(raw.execution.id,dev.execution.id);
 const reviewerId='synthetic-review-executor',assignmentId='synthetic-assignment/'+p.run.reviewId;
 const runPath='docs/review-execution.json';
 const rawSemanticSha256=fixtureResultDigest(raw);
 const anchor='docs/witnessed-original.json';copyFileSync(join(root,p.run.results.path),join(root,anchor));const rawResult=ref(anchor);
 writeFileSync(join(root,runPath),JSON.stringify({protocol:1,evidenceProfile:PROFILE,type:'gate-review-execution',reviewId:p.run.reviewId,assignmentId,reviewerId,target:p.target,exitCode:completedProcess.exitCode,argv:completedProcess.argv,execution:raw.execution,rawResult,rawSemanticSha256},null,2));
 const receipt={protocol:1,evidenceProfile:PROFILE,type:'gate-review-witness',reviewId:p.run.reviewId,role:'external-independent',reviewerId,assignmentId,method:'independent-replay',result:'passed',target:p.target,snapshot:p.snapshot,execution:raw.execution,rawResult,rawSemanticSha256,executionRecord:ref(runPath),assertions:raw.assertions};
 writeFileSync(join(root,'docs/review-receipt.json'),JSON.stringify(receipt,null,2));mkdirSync(join(root,'docs/quality'),{recursive:true});
 writeFileSync(join(root,'docs/quality/review-authority-v1.json'),JSON.stringify({version:1,model:'maintainer-witnessed-local-reviews',authorizations:[{reviewId:p.run.reviewId,record:ref('docs/review-receipt.json')}],note:'Isolated synthetic role simulation only; not product acceptance'},null,2));
}
