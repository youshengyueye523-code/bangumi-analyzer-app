/** Shared protocol-2 codec and evidence chain. No execution, database or network access. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
export const PROFILE = 'evidence-chain-v2';
export const REVIEW_AUTHORITY_PATH = 'docs/quality/review-authority-v1.json';
export const CLASSES = ['developer-test','developer-cross-check','external-independent','schema-observation','risk-acceptance'];
export const CHECKS = ['positive','negative','independentOracle','failurePath'];
const reviews = ['external-independent','risk-acceptance'];
const text = x => typeof x === 'string' && x.trim().length > 0;
const hash = x => typeof x === 'string' && /^[A-F0-9]{64}$/.test(x);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function requireThat(ok, reason) { if (!ok) throw Error(reason); }
export const sha256 = x => createHash('sha256').update(x).digest('hex').toUpperCase();
/** Stable maps; arrays retain order unless their typed normalizer declares a set. */
export function stable(value) {
 if (Array.isArray(value)) return value.map(stable);
 if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
 requireThat(value === null || ['string','boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)), 'invalid_json_value');
 return value;
}
export const encode = value => JSON.stringify(stable(value));
export function ids(values) {
 requireThat(Array.isArray(values) && values.every(x => text(x) && x === x.trim()) && new Set(values).size === values.length, 'invalid_or_duplicate_object_set');
 return [...values].sort();
}
function keyed(values, normalize) {
 requireThat(Array.isArray(values), 'record_set_required');
 const seen = new Set();
 return values.map(x => { requireThat(object(x) && text(x.id) && !seen.has(x.id), 'invalid_or_duplicate_record_id'); seen.add(x.id); return normalize(x); }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function fileRef(ref) {
 requireThat(object(ref) && text(ref.path) && !isAbsolute(ref.path) && /^(docs|packages|scripts)\//.test(ref.path) && !ref.path.includes('\\') && !ref.path.split('/').some(x=>x==='.'||x==='..') && hash(ref.sha256), 'invalid_file_reference');
 return {path:ref.path,sha256:ref.sha256};
}
export function createReader(repoRoot) {
 const root = realpathSync(repoRoot);
 const bytes = ref => { const r=fileRef(ref),p=realpathSync(resolve(root,r.path)),rel=relative(root,p);requireThat(!rel.startsWith('..')&&!isAbsolute(rel)&&/^(docs|packages|scripts)\//.test(rel.replaceAll('\\','/')),'file_outside_scope');const b=readFileSync(p);requireThat(sha256(b)===r.sha256,'file_hash_mismatch '+r.path);return b; };
 return {bytes,load:ref=>JSON.parse(bytes(ref).toString('utf8'))};
}
function target(t) { requireThat(object(t)&&text(t.id)&&text(t.version),'invalid_target'); return t; }
function schema(s) { requireThat(object(s)&&Number.isSafeInteger(s.version)&&s.version>0&&hash(s.censusSha256),'invalid_schema');return s; }
function snapshot(s) { requireThat(object(s)&&hash(s.policySha256)&&object(s.sources),'invalid_snapshot');schema(s.schema);for(const[id,h]of Object.entries(s.sources))requireThat(text(id)&&hash(h),'invalid_snapshot_source');return s; }
function time(t) { requireThat(text(t)&&/Z$/.test(t)&&Number.isFinite(Date.parse(t)),'invalid_utc_time');return Date.parse(t); }
function validateExecution(e, kind) {
 requireThat(object(e)&&text(e.id)&&CLASSES.includes(kind)&&e.classification===kind&&text(e.command),'invalid_execution');
 requireThat(reviews.includes(kind)?text(e.reviewId):e.reviewId===null,'invalid_execution_review_id');
 fileRef(e.runner);fileRef(e.fixture);return e;
}
export function claimContract(x, applicability=x.applicability) {
 requireThat(object(x)&&text(x.id)&&text(x.dimension)&&['P0','P1','P2','P3'].includes(x.priority)&&text(x.scope)&&['required','not-offered'].includes(applicability),'invalid_claim_contract');
 const rule={};for(const k of ['invariant','detection','handling','safeHandling']){requireThat(x[k]==null||text(x[k]),'invalid_claim_rule');rule[k]=x[k]??null;}
 const sources=ids(x.sources);requireThat(sources.length>0,'empty_claim_sources');
 return {id:x.id,dimension:x.dimension,priority:x.priority,scope:x.scope,sources,objects:ids(x.objects),applicability,rule};
}
export const claimDigest=(x,applicability)=>sha256(encode(claimContract(x,applicability)));
export function basisDigest(basis) {
 const b=structuredClone(basis);requireThat(b.version===1&&object(b.schema),'invalid_basis');
 b.records=keyed(b.records,x=>({...x,sources:ids(x.sources),objects:ids(x.objects)}));b.schema.ownerSources=ids(b.schema.ownerSources);
 return sha256(encode(b));
}
export const schemaDigest=(s,objects)=>sha256(encode({id:'schema:census',scope:'schema-inventory',schema:schema(s),objects:ids(objects)}));
export function assertion(a) {
 requireThat(object(a)&&text(a.id)&&text(a.scope)&&['passed','failed'].includes(a.result)&&hash(a.contractSha256),'invalid_assertion');
 if(a.id!=='schema:census')requireThat(object(a.checks)&&same(Object.keys(a.checks).sort(),[...CHECKS].sort())&&CHECKS.every(k=>typeof a.checks[k]==='boolean'),'invalid_assertion_checks');
 return {...a,objects:ids(a.objects)};
}
function observations(o) { if(o===undefined)return undefined;requireThat(object(o),'invalid_observations');schema(o.schema);return {...o,objects:ids(o.objects)}; }
/** Validates before canonicalization: duplicate IDs never disappear into a Map or Set. */
export function normalizeRaw(raw) {
 requireThat(object(raw)&&raw.protocol===2&&raw.evidenceProfile===PROFILE,'current_evidence_profile_required');
 requireThat(CLASSES.includes(raw.kind)&&['passed','failed'].includes(raw.result),'invalid_raw_result');target(raw.target);snapshot(raw.snapshot);validateExecution(raw.execution,raw.kind);
 time(raw.executedAt);
 if(raw.expiresAt!==undefined)time(raw.expiresAt);
 const assertions=keyed(raw.assertions,assertion);requireThat(assertions.length>0,'empty_raw_assertions');
 if(raw.result==='passed')requireThat(assertions.every(a=>a.result==='passed'&&(a.id==='schema:census'||CHECKS.every(k=>a.checks[k]===true))),'passed_run_has_failed_assertion');
 if(raw.kind==='risk-acceptance')requireThat(object(raw.approval)&&text(raw.approval.approvedBy)&&text(raw.approval.reason),'approval_required');
 else requireThat(raw.approval===undefined,'unexpected_approval');
 const value={...raw,assertions};if(raw.observations!==undefined)value.observations=observations(raw.observations);
 return stable(value);
}
export const resultDigest=raw=>sha256(encode(normalizeRaw(raw)));
export const runIdentity=raw=>({runId:raw.execution.id,semanticSha256:resultDigest(raw)});
export function execution(p) { return {id:p.run.id,classification:p.kind,reviewId:p.run.reviewId,command:p.run.command,runner:p.run.runner,fixture:p.run.fixture}; }
export function verifyRun(p,raw) {
 requireThat(p.protocol===2&&p.evidenceProfile===PROFILE,'current_evidence_profile_required');
 requireThat(object(p.run)&&p.run.classification===p.kind,'proof_execution_classification_mismatch');
 requireThat(same(raw.execution,execution(p))&&raw.kind===p.kind,'raw_execution_class_or_identity_mismatch');
 requireThat(same(raw.target,p.target)&&raw.result===p.result&&raw.executedAt===p.executedAt&&same(raw.snapshot,p.snapshot),'raw_run_snapshot_or_producer_mismatch');
 requireThat(raw.expiresAt===p.expiresAt&&same(raw.approval,p.approval)&&same(observations(raw.observations),observations(p.observations)),'raw_observation_approval_or_validity_mismatch');
}
function witnessHeader(w, kind) {
 requireThat(object(w)&&w.protocol===1&&w.evidenceProfile===PROFILE&&w.type==='gate-review-witness'&&w.role===kind&&w.result==='passed'&&text(w.reviewId)&&text(w.reviewerId)&&text(w.assignmentId)&&w.method===(kind==='external-independent'?'independent-replay':'risk-approval'),'invalid_review_receipt');
 target(w.target);snapshot(w.snapshot);validateExecution(w.execution,kind);fileRef(w.executionRecord);fileRef(w.rawResult);requireThat(hash(w.rawSemanticSha256),'invalid_review_digest');
}
export function qualifyReview(authority,proof,reader) {
 const {p,raw}=proof,deny=reason=>({qualified:false,reason,claims:[]});
 if(!reviews.includes(p.kind))return deny('not_a_review_class');
 if(!object(authority)||authority.version!==1||authority.model!=='maintainer-witnessed-local-reviews'||!Array.isArray(authority.authorizations))return deny('review_authority_unavailable');
 const entries=authority.authorizations.filter(x=>object(x)&&x.reviewId===p.run.reviewId);if(entries.length!==1)return deny('review_not_uniquely_authorized');
 const w=reader.load(entries[0].record);witnessHeader(w,p.kind);
 const log=reader.load(w.executionRecord);
 requireThat(object(log)&&log.protocol===1&&log.evidenceProfile===PROFILE&&log.type==='gate-review-execution'&&Number.isSafeInteger(log.exitCode)&&log.exitCode===0&&Array.isArray(log.argv)&&log.argv.length>0&&log.argv.every(text),'invalid_review_execution_record');
 fileRef(log.rawResult);
 requireThat(same(fileRef(log.rawResult),fileRef(w.rawResult)),'witness_anchor_reference_conflict');
 // Material identity: this must load the ORIGINAL bytes even when proof uses an equivalent representation.
 const anchor=normalizeRaw(reader.load(w.rawResult)),semanticSha256=resultDigest(anchor);
 requireThat(same(anchor,normalizeRaw(raw))&&semanticSha256===w.rawSemanticSha256&&semanticSha256===log.rawSemanticSha256,'witness_anchor_semantic_mismatch');
 requireThat(w.reviewId===p.run.reviewId&&w.reviewId===log.reviewId&&w.assignmentId===log.assignmentId&&w.reviewerId===log.reviewerId&&same(w.target,anchor.target)&&same(log.target,anchor.target)&&same(w.snapshot,anchor.snapshot)&&same(w.execution,anchor.execution)&&same(log.execution,anchor.execution)&&anchor.result==='passed','review_execution_identity_or_scope_mismatch');
 const expected=new Map(anchor.assertions.map(a=>[a.id,a])),claims=keyed(w.assertions,assertion);requireThat(claims.length>0,'review_claims_missing');
 for(const a of claims)requireThat(same(expected.get(a.id),stable(a)),'review_assertion_scope_mismatch');
 return {qualified:true,reason:'maintainer_witnessed_original_execution',claims:claims.map(a=>({id:a.id,contractSha256:a.contractSha256}))};
}
const validated=new WeakMap();
/** Single construction boundary: callers cannot grant eligibility with an arbitrary qualified flag. */
export function validateEvidenceChain(entry,context) {
 const {reader,registry:r,expected,sources,schemaIds,authority}=context,p=reader.load(entry);
 const raw=normalizeRaw(reader.load(p.run?.results));verifyRun(p,raw);
 requireThat(time(raw.executedAt)<=Date.now()+60_000,'evidence_time_unverifiable');
 if(raw.expiresAt!==undefined)requireThat(time(raw.expiresAt)>=Date.now(),'evidence_expired');
 requireThat(entry.kind===p.kind&&entry.result===p.result&&entry.scope===p.target.id&&same(p.target,r.target),'evidence_entry_scope_mismatch');
 requireThat(p.snapshot.policySha256===r.coverageBasis.semanticSha256&&same(p.snapshot.schema,{version:r.schema.version,censusSha256:r.schema.sha256}),'evidence_version_or_census_mismatch');
 for(const[id,h]of Object.entries(p.snapshot.sources))requireThat(sources.has(id)&&sources.get(id).sha256===h,'evidence_source_snapshot_mismatch '+id);
 reader.bytes(raw.execution.runner);reader.bytes(raw.execution.fixture);
 const checkContract=a=>{const b=expected.get(a.id),objects=b?ids(b.objects):a.id==='schema:census'?ids(schemaIds):null,contract=b?claimDigest(b,b.applicability):a.id==='schema:census'?schemaDigest(p.snapshot.schema,schemaIds):null;requireThat(objects&&same(a.objects,objects)&&a.contractSha256===contract,'assertion_object_contract_mismatch '+a.id);};
 for(const a of raw.assertions)checkContract(a);
 if(raw.observations)requireThat(same(raw.observations.schema,p.snapshot.schema)&&same(raw.observations.objects,ids(schemaIds)),'schema_observation_mismatch');
 const byId=new Map(raw.assertions.map(a=>[a.id,a])),assertions=keyed(p.assertions,assertion);requireThat(assertions.length>0,'empty_proof_assertions');
 for(const a of assertions)requireThat(same(byId.get(a.id),stable(a)),'invalid_bound_assertion');
 const proof={entry,p,raw,assertions:new Map(assertions.map(a=>[a.id,stable(a)])),origin:null,identity:runIdentity(raw)};
 proof.origin=qualifyReview(authority,proof,reader);
 // The private state, not caller flags, is the authority for downstream claim eligibility.
 validated.set(proof,{p:structuredClone(p),assertions:structuredClone(proof.assertions),origin:structuredClone(proof.origin)});
 return proof;
}
export function eligibleClaim(proof,x,kind,context) {
 const state=validated.get(proof);if(!state)return false;const {p,assertions,origin}=state,b=context.expected.get(x.id);
 return p.result==='passed'&&(kind?p.kind===kind:['developer-test','developer-cross-check','external-independent'].includes(p.kind))&&(!reviews.includes(p.kind)||(origin.qualified&&origin.claims.some(c=>c.id===x.id&&c.contractSha256===claimDigest(x,b.applicability))))&&x.sources.every(id=>p.snapshot.sources[id]===context.sources.get(id)?.sha256)&&assertions.get(x.id)?.scope===x.scope&&assertions.get(x.id)?.result==='passed'&&assertions.get(x.id)?.contractSha256===claimDigest(x,b.applicability)&&CHECKS.every(k=>assertions.get(x.id)?.checks?.[k]===true);
}
