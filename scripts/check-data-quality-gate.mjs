/** Evidence protocol 2. Reads only registered files; never executes a producer or opens a database. */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REVIEW_AUTHORITY_PATH,PROFILE,ids,claimDigest,basisDigest,createReader,validateEvidenceChain,eligibleClaim } from './gate-evidence-contract.mjs';
export const STATES=['verified','partial','uncovered','unknown','not-applicable'];
const DIMS=['data','anomaly','path','repair','truth'];
const CHECKS=['positive','negative','independentOracle','failurePath'];
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
const hash=x=>typeof x==='string'&&/^[A-F0-9]{64}$/.test(x);
const digest=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const same=isDeepStrictEqual;
const sorted=a=>[...a].sort();
const tally=()=>({total:0,verified:0,partial:0,uncovered:0,unknown:0,'not-applicable':0});
const dimension=id=>typeof id!=='string'?null:id.startsWith('table:')||id.startsWith('field:')?'data':id.startsWith('risk:')?'anomaly':['path','repair','truth'].find(d=>id.startsWith(d+':'))??null;
export function evaluateGate(registryPath,repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')) {
 const errors=[],blockers=[],stats=Object.fromEntries(DIMS.map(d=>[d,tally()]));
 const fail=(code,id='')=>errors.push(code+(id?': '+id:''));
 const block=(id,reason,status)=>blockers.push({id,reason,...(status?{status}:{})});
 const root=realpathSync(repoRoot);let authority=null;try{const p=realpathSync(resolve(root,REVIEW_AUTHORITY_PATH)),rel=relative(root,p);if(rel.startsWith('..')||isAbsolute(rel))throw Error('review_authority_outside_scope');authority=JSON.parse(readFileSync(p,'utf8'));}catch{};const origins=[],runIdentities=new Map();
 const reader=createReader(root),read=(path,sha)=>reader.bytes({path,sha256:sha}),load=reader.load;
 let r,basis;const sources=new Map(),proofs=new Map(),records=new Map();
 try {
  r=JSON.parse(readFileSync(registryPath,'utf8'));
  if(r.version!==2)throw Error('evidence_protocol_2_required; legacy references are historical, not current proof');
  if(r.evidenceProfile!==PROFILE)throw Error('current_registry_profile_required');
  if(!Array.isArray(r.records)||!Array.isArray(r.sources)||!Array.isArray(r.evidence)||!Array.isArray(r.finalIndependentEvidence))throw Error('invalid_registry_arrays');
  if(!nonempty(r.target?.id)||!nonempty(r.target?.version))throw Error('invalid_target');
  basis=load(r.coverageBasis);
  if(basis.evidenceProfile!==PROFILE)throw Error('current_basis_profile_required');
  ids(r.finalIndependentEvidence);
  if(basis.version!==1||!same(basis.target,r.target)||!Array.isArray(basis.records)||!basis.sources)throw Error('invalid_coverage_basis');
  if(!hash(r.coverageBasis.semanticSha256)||r.coverageBasis.semanticSha256!==basisDigest(basis))throw Error('coverage_basis_semantic_digest_mismatch');
  if(!same(basis.repairCatalogue,r.repairCatalogue))fail('repair_catalogue_basis_mismatch');
  const allIDs=new Set();
  for(const s of r.sources){if(!nonempty(s.id)||allIDs.has(s.id))throw Error('duplicate_source '+s.id);allIDs.add(s.id);read(s.path,s.sha256);sources.set(s.id,s);}
  if(!same(sorted([...sources.keys()]),sorted(Object.keys(basis.sources))))fail('source_inventory_mismatch');
  for(const [id,s]of sources)if(!same({path:s.path,sha256:s.sha256},basis.sources[id]))fail('basis_source_stale',id);
  const census=load(r.schema),schemaIds=census.tables.flatMap(t=>['table:'+t.table,...t.columns.map(c=>'field:'+t.table+'.'+c.name)]);
  const expected=new Map();
  for(const b of basis.records){if(!nonempty(b.id)||expected.has(b.id)||dimension(b.id)!==b.dimension||!['P0','P1','P2','P3'].includes(b.priority)||!nonempty(b.scope)||!Array.isArray(b.sources)||!b.sources.length||!['required','not-offered'].includes(b.applicability))throw Error('invalid_basis_claim');claimDigest(b,b.applicability);expected.set(b.id,b);}
  for(const b of expected.values())for(const id of ids(b.objects))if(!expected.has(id))throw Error('basis_dangling_object '+id);
  for(const e of r.evidence){
   if(!nonempty(e.id)||allIDs.has(e.id)){fail('duplicate_evidence',e.id);continue;}allIDs.add(e.id);
   try {
    const bytes=read(e.path,e.sha256);
    if(e.usage==='historical'){proofs.set(e.id,{entry:e,historical:true});continue;}
    if(e.usage!=='active')throw Error('evidence_usage_required');
    const proof=validateEvidenceChain(e,{reader,registry:r,expected,sources,schemaIds,authority});
    if(runIdentities.has(proof.identity.runId)&&!same(runIdentities.get(proof.identity.runId),proof.identity))throw Error('execution_identity_conflict');runIdentities.set(proof.identity.runId,proof.identity);
    origins.push({evidenceId:e.id,kind:proof.p.kind,runId:proof.p.run.id,...proof.origin});
    if(['external-independent','risk-acceptance'].includes(proof.p.kind)&&!proof.origin.qualified)block('evidence:'+e.id,'review_origin_unverifiable_'+proof.origin.reason);
    proofs.set(e.id,proof);
   }catch(error){fail(error.message,e.id);}
  }
  for(const x of r.records){
   const d=dimension(x.id);
   if(!d||records.has(x.id)){fail('invalid_or_duplicate_claim',x.id);continue;}records.set(x.id,x);
   if(x.dimension!==d)fail('claim_dimension_mismatch',x.id);
   if(!STATES.includes(x.status)||!['P0','P1','P2','P3'].includes(x.priority)){fail('invalid_claim_status',x.id);continue;}
   stats[d].total++;stats[d][x.status]++;
   const b=expected.get(x.id);
   try{if(!b||claimDigest(x,b.applicability)!==claimDigest(b,b.applicability))fail('claim_object_or_rule_contract_mismatch',x.id);}catch(error){fail(error.message,x.id);}
   if(!b||b.dimension!==x.dimension||b.priority!==x.priority||b.scope!==x.scope||!Array.isArray(x.sources)||!same(sorted(b.sources),sorted(x.sources)))fail('claim_basis_mismatch',x.id);
   if(!nonempty(x.owner)||!nonempty(x.residual)||!Array.isArray(x.matrix)||!x.matrix.every(nonempty)||!x.matrix.length||!Array.isArray(x.sources)||x.sources.some(id=>!sources.has(id))||!Array.isArray(x.evidence)||new Set(x.evidence).size!==x.evidence.length||x.evidence.some(id=>!proofs.has(id)))fail('claim_reference_incomplete',x.id);
   if(d==='anomaly')for(const k of ['invariant','proof','origin','detection','trigger','locateExplain','handling','human','falsePositive','falseNegative','samples'])if(!(nonempty(x[k])||(Array.isArray(x[k])&&x[k].length&&x[k].every(nonempty))))fail('anomaly_contract_missing_'+k,x.id);
   for(const id of ids(x.objects))if(!expected.has(id))fail('dangling_object',id);
  }
  for(const id of expected.keys())if(!records.has(id))fail('required_claim_missing',id);
  if(!Number.isSafeInteger(r.schema.version)||r.schema.version<1||census.schema!==r.schema.version||!same({...basis.schema,ownerSources:ids(basis.schema.ownerSources)},{version:r.schema.version,censusSha256:r.schema.sha256,ownerSources:ids(r.schema.ownerSources)}))fail('schema_lineage_mismatch');
  if(!Array.isArray(r.schema.ownerSources)||!r.schema.ownerSources.length||r.schema.ownerSources.some(id=>!sources.has(id)))fail('schema_owner_missing');
  if(new Set(schemaIds).size!==schemaIds.length)fail('duplicate_census_object');
  for(const id of schemaIds)if(records.get(id)?.dimension!=='data')fail('schema_object_missing_or_misclassified',id);
  for(const id of records.keys())if(/^(table|field):/.test(id)&&!schemaIds.includes(id))fail('claim_not_in_census',id);
  const dependenciesMatch=(proof,ids)=>ids.every(id=>hash(proof.p.snapshot.sources[id])&&proof.p.snapshot.sources[id]===sources.get(id)?.sha256);
  const generation=proofs.get(r.schema.generationEvidence);
  if(!generation||generation.historical||generation.p.result!=='passed'||!dependenciesMatch(generation,r.schema.ownerSources)||!['schema-observation','developer-test','developer-cross-check','external-independent'].includes(generation.p.kind)||!same(generation.p.observations?.schema,{version:r.schema.version,censusSha256:r.schema.sha256})||!same(ids(generation.p.observations?.objects),ids(schemaIds)))fail('schema_generation_unverifiable');
  const contract=read(r.repairCatalogue.path,r.repairCatalogue.sha256).toString('utf8'),supported=new Set();
  for(const name of ['DIAGNOSTIC_REPAIR_KINDS','FRANCHISE_GOVERNANCE_KINDS']){const body=new RegExp('export const '+name+' = \\[([\\s\\S]*?)\\]').exec(contract)?.[1];if(body===undefined)throw Error('repair_catalogue_unverifiable');for(const m of body.matchAll(/'([^']+)'/g))supported.add('repair:'+m[1]);}
  for(const id of supported){if(!records.has(id))fail('supported_repair_missing',id);if(records.get(id)?.status==='not-applicable'||expected.get(id)?.applicability!=='required')fail('supported_repair_cannot_be_na',id);}
  const matches=(proof,x,kind)=>eligibleClaim(proof,x,kind,{expected,sources});
  for(const x of records.values()){
   const b=expected.get(x.id);if(!b||!STATES.includes(x.status))continue;
   if(x.status==='not-applicable'){
    if(x.dimension!=='repair'||supported.has(x.id)||b.applicability!=='not-offered'||x.applicability?.code!=='not-offered'||!nonempty(x.notApplicableReason)||x.applicability?.catalogueSha256!==r.repairCatalogue.sha256)fail('na_applicability_unproved',x.id);
    continue;
   }
   if(b.applicability!=='required')fail('nonoffered_claim_wrong_state',x.id);
   if(x.dimension==='repair'&&!supported.has(x.id))fail('invented_supported_repair',x.id);
   if(x.status==='verified'){
    if(!CHECKS.every(k=>x.validation?.[k]===true))fail('strict_validation_required',x.id);
    if(!x.evidence?.some(id=>matches(proofs.get(id),x)))block(x.id,'current_scoped_evidence_missing_or_stale',x.status);
   }else if(['P0','P1'].includes(x.priority))block(x.id,'critical_scope_not_verified',x.status);
   else {
    const ap=x.acceptance,proof=proofs.get(ap?.evidenceId);
    if(!nonempty(ap?.approvedBy)||!nonempty(ap?.reason)||!matches(proof,x,'risk-acceptance')||proof.p.approval?.approvedBy!==ap.approvedBy||proof.p.approval?.reason!==ap.reason)block(x.id,'explicit_versioned_risk_acceptance_missing',x.status);
   }
  }
  const critical=[...records.values()].filter(x=>['P0','P1'].includes(x.priority)&&expected.get(x.id)?.applicability==='required');
  const independentMissing=critical.filter(x=>!r.finalIndependentEvidence.some(id=>matches(proofs.get(id),x,'external-independent'))).map(x=>x.id);
  for(const id of r.finalIndependentEvidence)if(!proofs.has(id)||proofs.get(id).historical||proofs.get(id).p.kind!=='external-independent'||!proofs.get(id).origin.qualified)fail('invalid_final_independent_reference',id);
  if(independentMissing.length)block('gate:external-independent','current_scope_independent_evidence_missing_for '+independentMissing.join(', '));
  for(const d of DIMS)if(!stats[d].total)fail('empty_denominator',d);
 }catch(error){fail(error.message);}
 const partitions={};for(const x of records.values()){const d=dimension(x.id);if(!d||!STATES.includes(x.status))continue;const grain=d==='data'?(x.id.startsWith('table:')?'table':'field'):d==='anomaly'?(x.id.startsWith('risk:issue:')?'registered-template':'risk-family'):d;const key=d+'/'+grain+'/'+x.priority;const s=partitions[key]??={total:0,...Object.fromEntries(STATES.map(t=>[t,0]))};s.total++;s[x.status]++;}
 return {status:errors.length?'INVALID':blockers.length?'NOT_READY':'READY_FOR_FINAL_SCOPE',protocol:2,evidenceProfile:PROFILE,reviewAuthority:{path:REVIEW_AUTHORITY_PATH,available:authority!==null,authorizedRecords:authority?.authorizations?.length??0},origins,gateIsSuggested:true,note:'Current scope only; unknown/partial/uncovered/N/A stay in the denominator. Version binding is not cryptographic authorship or semantic truth.',dimensions:Object.fromEntries(Object.entries(stats).map(([d,s])=>[d,{...s,verifiedFraction:s.verified+'/'+s.total}])),partitions,errors,blockers};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const args=process.argv.slice(2),at=args.indexOf('--registry'),out=args.indexOf('--out'),result=evaluateGate(at<0?resolve(dirname(fileURLToPath(import.meta.url)),'../docs/quality/coverage-registry.json'):resolve(args[at+1]));if(out>=0)writeFileSync(resolve(args[out+1]),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,dimensions:result.dimensions,errors:result.errors,blockers:result.blockers.length}));process.exitCode=result.errors.length?2:result.blockers.length?1:0;}catch(error){console.error(error.message);process.exitCode=2;}}
