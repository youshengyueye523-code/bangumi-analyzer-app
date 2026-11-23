/** HTTP-only evidence projection. Domain reports, history and Verify remain Real.
 * Free text has no dependable historical provenance: never try to scrub names.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { ApiError, DIAGNOSTIC_REPAIR_KINDS, type DiagnosticRepairPreview } from '@bangumi-analyzer/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { all } from '../db/index.js';
import { hideNsfwEnabled, personallyVisibleId, personalHidesActive, personalSeriesNameSafe, personalFranchiseNameSafe } from '../db/visibility.js';
import { PUBLIC_DIAGNOSTIC_TEXT } from './presentationCatalog.js';
import { visibleForeignKeys } from './foreignKeys.js';
import { visibleSourceSnapshots } from './sourceSnapshots.js';
import { OBSERVATION_BOUNDARY } from './freshness.js';

type Row = Record<string, any>;
const PROTECTED = '受保护证据：原文完整保留，需通过独立「完整审计证据」确认入口查看。';
const salt = randomBytes(32);
const known = new Set<string>(PUBLIC_DIAGNOSTIC_TEXT);
const text = (s: unknown, fallback = PROTECTED): string => typeof s === 'string' && known.has(s) ? s : fallback;
const opaque = (s: unknown) => `protected-${createHmac('sha256', salt).update(String(s)).digest('hex').slice(0, 24)}`;
const enumValue = (s: unknown, values: readonly string[], fallback: string) => values.includes(String(s)) ? String(s) : fallback;
const number = (s: unknown) => {
  if (typeof s !== 'number' || !Number.isFinite(s)) throw new Error('Invalid evidence counter');
  return s;
};
const stamp = (s: unknown) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s) ? s : null;
const strings = (a: unknown) => Array.isArray(a) ? a.map(x => text(x)) : [];
const layers = ['source', 'governance', 'projection', 'search', 'api', 'ui', 'detector', 'cache'];
const states = ['confirmed', 'provisional', 'probable', 'candidate', 'rejected', 'stale', 'conflict', 'manual', 'auto', 'active', 'revoked', 'resolved', 'unresolved', 'contested', 'stable'];

export function evidenceMode(request: FastifyRequest): 'real' | 'visible' {
  const q = request.query as Record<string, unknown>;
  const intent = q?.evidence;
  const header = request.headers['x-analyzer-evidence'];
  if (intent === undefined && header === undefined) return 'visible';
  let foreign = request.headers['sec-fetch-site'] === 'cross-site';
  if (request.headers.origin) {
    try { foreign ||= new URL(request.headers.origin).origin !== `${request.protocol}://${request.headers.host}`; }
    catch { foreign = true; }
  }
  if (intent !== 'real' || header !== 'real' || foreign) {
    throw new ApiError('完整审计证据需要独立明确确认', { code: 'evidence_confirmation_required', status: 403, dataIntact: true });
  }
  return 'real';
}

function context() {
  const refs = new Map<string, { title: string; key: string; id: number; kind: string }>();
  const byId = new Map<string, string>();
  for (const s of all<Row>(`SELECT id,name,name_cn FROM subjects WHERE nsfw=0 AND ${personallyVisibleId('id')}`)) {
    refs.set(`/subjects/${s.id}`, { title: s.name_cn || s.name, key: String(s.id), id: s.id, kind: 'subject' });
  }
  for (const s of all<Row>(`SELECT e.id,e.key,e.title FROM series_entities e WHERE e.state <> 'stale' AND ${personalSeriesNameSafe('e.id')}
    AND EXISTS(SELECT 1 FROM series_entity_members m JOIN subjects s ON s.id=m.subject_id WHERE m.series_id=e.id AND m.role='primary' AND s.nsfw=0)
    AND NOT EXISTS(SELECT 1 FROM series_entity_members m LEFT JOIN subjects s ON s.id=m.subject_id
      WHERE m.series_id=e.id AND m.role='primary' AND (s.id IS NULL OR s.nsfw=1))`)) {
    refs.set(`/series/${encodeURIComponent(s.key)}`, { ...s, kind: 'series' } as any);
    byId.set(`series:${s.id}`, `/series/${encodeURIComponent(s.key)}`);
  }
  // A mixed family title/evidence can originate in a hidden member. Only a fully
  // public lineage is positively proven here; unknown provenance stays protected.
  for (const f of all<Row>(`SELECT f.id,f.key,f.title FROM franchise_entities f WHERE f.state <> 'stale' AND ${personalFranchiseNameSafe('f.id')}
    AND EXISTS(SELECT 1 FROM franchise_series fs WHERE fs.franchise_id=f.id)
    AND NOT EXISTS(SELECT 1 FROM franchise_series fs WHERE fs.franchise_id=f.id AND NOT EXISTS(
      SELECT 1 FROM series_entity_members m JOIN subjects s ON s.id=m.subject_id WHERE m.series_id=fs.series_id AND m.role='primary' AND s.nsfw=0))
    AND NOT EXISTS(SELECT 1 FROM franchise_series fs JOIN series_entity_members m ON m.series_id=fs.series_id
      LEFT JOIN subjects s ON s.id=m.subject_id WHERE fs.franchise_id=f.id AND (s.id IS NULL OR s.nsfw=1))`)) {
    refs.set(`/franchises/${encodeURIComponent(f.key)}`, { ...f, kind: 'franchise' } as any);
    byId.set(`franchise:${f.id}`, `/franchises/${encodeURIComponent(f.key)}`);
  }
  const hiddenSubjects=new Set(all<{id:number}>(`SELECT id FROM subjects WHERE nsfw=1 OR NOT (${personallyVisibleId('id')})`).map(x=>x.id));
  return { refs, byId, hiddenSubjects };
}
type Context = ReturnType<typeof context>;
function ref(c: Context, href: unknown) {
  if (typeof href !== 'string') return undefined;
  try {
    const [path] = href.split('?');
    const match = /^\/(subjects|series|franchises)\/([^/]+)$/.exec(path!);
    return match ? c.refs.get(`/${match[1]}/${encodeURIComponent(decodeURIComponent(match[2]!))}`) : undefined;
  } catch { return undefined; }
}
function hrefOf(r: NonNullable<ReturnType<typeof ref>>) {
  return `/${r.kind === 'subject' ? 'subjects' : r.kind === 'series' ? 'series' : 'franchises'}/${encodeURIComponent(r.key)}`;
}
function preview(p: Row | null): (DiagnosticRepairPreview & { requiresRealEvidence?: boolean }) | null {
  if (!p) return null;
  const projected = {
    current: text(p.current), next: text(p.next), reason: text(p.reason), source: text(p.source),
    directlyChanges: strings(p.directlyChanges), derivedChanges: strings(p.derivedChanges), untouched: strings(p.untouched),
    chain: Array.isArray(p.chain) ? p.chain.map((s: Row) => ({ layer: enumValue(s.layer, layers, 'governance') as any, label: text(s.label), detail: text(s.detail) })) : [],
  };
  return { ...projected, requiresRealEvidence: JSON.stringify(projected).includes(PROTECTED) };
}
function issueId(id: unknown) {
  return typeof id === 'string' && /^[a-z.-]+$/.test(id) && known.has(id) ? id : opaque(id);
}
function report(raw: Row, c: Context): Row {
  return {
    generatedAt: stamp(raw.generatedAt), durationMs: number(raw.durationMs), dataVersion: number(raw.dataVersion), hideNsfw: true,
    ...(raw.freshness ? {freshness:{status:enumValue(raw.freshness.status,['snapshot','expired'],'expired'),
      observedAt:stamp(raw.freshness.observedAt),validUntil:stamp(raw.freshness.validUntil),
      reason:raw.freshness.reason===null ? null : enumValue(raw.freshness.reason,['age','local-change','clock'],'clock'),boundary:OBSERVATION_BOUNDARY}} : {}),
    coverage: raw.coverage?.status === 'complete' ? { status: 'complete', note: '完整性指全部注册检查；问题数量为完整审计口径，详情经过隐私投影。' } : undefined,
    issuePage: raw.issuePage ? { offset: number(raw.issuePage.offset), limit: number(raw.issuePage.limit), total: number(raw.issuePage.total), hasMore: raw.issuePage.hasMore === true } : undefined,
    scope: Object.fromEntries(['subjects','collections','relations','series','franchises','staleSeries'].map(k => [k, number(raw.scope?.[k])])),
    summary: Object.fromEntries(['error','suspicious','needs-review','uncertain','external','info','total'].map(k => [k, number(raw.summary?.[k])])),
    lastMutation: { scope: raw.lastMutation?.scope == null ? null : text(raw.lastMutation.scope, '受保护操作类型'), at: stamp(raw.lastMutation?.at), detail: raw.lastMutation?.detail == null ? null : PROTECTED },
    modules: (raw.modules ?? []).map((m: Row) => ({ id: text(m.id, 'protected'), label: text(m.label, '诊断模块'), description: text(m.description), status: enumValue(m.status, ['ok','attention','error','skipped'], 'skipped'), checked: number(m.checked), details: strings(m.details), ...(m.foreignKeys ? {foreignKeys:visibleForeignKeys(m.foreignKeys)} : {}), ...(m.sourceSnapshots ? {sourceSnapshots:visibleSourceSnapshots(m.sourceSnapshots)} : {}) })),
    issues: (raw.issues ?? []).map((i: Row) => ({
      id: issueId(i.id), detector: text(i.detector, 'protected'), category: text(i.category, '诊断'), severity: enumValue(i.severity, ['error','suspicious','needs-review','uncertain','external','info'], 'uncertain'),
      title: text(i.title, `${text(i.category, '诊断')}：${number(i.affectedCount)} 个受影响对象`), explanation: text(i.explanation),
      evidence: (i.evidence ?? []).map((e: Row) => ({ label: text(e.label, '审计证据'), value: text(e.value) })),
      impact: (i.impact ?? []).map((e: Row) => ({ kind: enumValue(e.kind, ['subject','series','franchise','search','projection','api','ui','storage'], 'ui'), label: text(e.label, '下游投影'), ...(ref(c,e.href) ? { href: hrefOf(ref(c,e.href)!) } : {}) })),
      affected: (i.affected ?? []).map((e: Row) => { const r=ref(c,e.href); return r ? { label: r.title, href: hrefOf(r), detail: '当前可见实体；历史关联证据需独立确认。' } : { label: '受保护或无法证明公开的关联对象', detail: PROTECTED }; }),
      affectedCount: number(i.affectedCount),
      ...(i.foreignKeys ? {foreignKeys:visibleForeignKeys(i.foreignKeys)} : {}),
      ...(i.sourceSnapshots ? {sourceSnapshots:visibleSourceSnapshots(i.sourceSnapshots)} : {}),
      actions: (i.actions ?? []).flatMap((a: Row) => {
        const r=ref(c,a.href);
        const staticHref=typeof a.href === 'string' && known.has(a.href) && /^\/(?!api\/|\/)/.test(a.href) ? a.href : undefined;
        if (a.kind !== 'repair') return [{ kind:'link', label:text(a.label,'查看治理对象'), href:r ? hrefOf(r) : staticHref ?? '/diagnostics', hint:r || staticHref ? text(a.hint,'当前可见入口') : PROTECTED }];
        if (!DIAGNOSTIC_REPAIR_KINDS.includes(a.repairKind)) return [];
        const safeTarget = !a.target && !a.value && issueId(i.id) === i.id;
        return [{ kind:'repair', repairKind:a.repairKind, label:text(a.label,'治理操作'), preview: { ...preview(a.preview), ...(!safeTarget ? { requiresRealEvidence:true } : {}) } }];
      }),
      ...(i.waitingFor ? { waitingFor:text(i.waitingFor) } : {}),
      ...(i.waiting ? { waiting:{ kind:enumValue(i.waiting.kind,['collection','detail-sync','bangumi-field','relation-update','manual-review','network','none'],'manual-review'), label:text(i.waiting.label,'等待条件'), detail:text(i.waiting.detail) } } : {}),
    })),
  };
}
function verification(v: Row): Row {
  return { verified:v.verified === true, partial:v.partial === true, summary:text(v.summary, v.verified ? '本次修复已通过内部验证；部分审计证据受保护。' : '验证未全部通过；请审阅验证层级，必要时独立确认完整证据。'),
    resolvedIssueIds:(v.resolvedIssueIds ?? []).map(issueId), remainingIssueIds:(v.remainingIssueIds ?? []).map(issueId),
    checks:(v.checks ?? []).map((s: Row) => ({ layer:enumValue(s.layer,layers,'governance'), label:text(s.label,'验证检查'), ok:s.ok === true, detail:text(s.detail, s.ok ? '此检查通过；原始验证证据保留。' : '此检查未通过；原始验证证据保留，需进一步处理。') })) };
}
function history(raw: Row, c: Context): Row {
  return { total:number(raw.total), filters: { entityKind:enumValue(raw.filters?.entityKind,['all','series','franchise'],'all'), actor:enumValue(raw.filters?.actor,['all','user','system','maintenance'],'all'), limit:number(raw.filters?.limit) },
    entries:(raw.entries ?? []).map((e: Row) => { const path=c.byId.get(`${e.entityKind}:${e.entityId}`);const r=path ? ref(c,path) : undefined; return {
      id:typeof e.id === 'string' && /^(event|decision):\d+$/.test(e.id) ? e.id : opaque(e.id),at:stamp(e.at),source:enumValue(e.source,['entity_event','candidate_decision'],'entity_event'),kind:text(e.kind,'protected-event'),
      summary:`${text(e.kind,'治理事件')}：${r ? '当前可见实体' : '受保护实体'}；历史证据原文保留`,actor:enumValue(e.actor,['user','system','maintenance'],'system'),
      entityKind:enumValue(e.entityKind,['series','franchise','legacy'],'legacy'),entityId:r ? r.id : 0,entityKey:r?.key ?? null,entityTitle:r?.title ?? '受保护实体',
      currentState:enumValue(e.currentState,states,'unknown'),candidate:e.candidate ? {kind:'protected',title:PROTECTED} : null,stateChange:e.stateChange ? PROTECTED : null,
      reason:e.reason ? PROTECTED : null,evidence:e.evidence ? '安全摘要：事件类型、时间、操作者与当前可见对象如上；历史自由文本、旧名称和嵌套关联未获公开来源证明，原文未被修改。' : null,
    }; }) };
}
function detail(raw: Row, c: Context): Row {
  // Closed top-level DTO: unknown future audit attachments must not bypass the projection.
  const fields=['key','title','titleState','titleSource','state','memberCount','collectedCount','confirmedCount','candidateCount','totalEpisodes','averageRate','firstYear','lastYear','statusCounts','evidenceCoverage','coverSubjects','ranking','canonicalKey','members','related','mergeCandidates','titleConfirmedAt','franchise','watch','analysis','seriesCount','confirmedSeriesCount','provisionalSeriesCount','candidateSeriesCount','conflictSeriesCount','knownCount','ok','confirmed','rejected','reopened','previousState','titleChanged','newTitle'];
  const out: Row=Object.fromEntries(fields.filter(k=>k in raw).map(k=>[k,raw[k]]));
  if (personalHidesActive()) {
    delete out.newTitle;
    for (const key of ['rejected','reopened','confirmed']) if (typeof out[key] === 'string') delete out[key];
  }
  if ('titleSource' in raw) out.titleSource=text(raw.titleSource,'受保护来源');
  out.aliasedFrom=raw.aliasedFrom ? PROTECTED : null;
  if (Array.isArray(raw.titleCandidates)) {
    const publicTitles=new Set([...c.refs.values()].map(r=>r.title));
    out.titleCandidates=raw.titleCandidates.filter((x: Row)=>publicTitles.has(x.title)).map((x: Row)=>({title:x.title,source:text(x.source,'受保护来源'),state:enumValue(x.state,states,'provisional'),evidence:PROTECTED,...(typeof x.valid==='boolean'?{valid:x.valid}:{}),...(typeof x.rejected==='boolean'?{rejected:x.rejected}:{}),rejectReason:x.rejectReason ? PROTECTED : undefined,rejectedAt:stamp(x.rejectedAt)}));
    out.protectedTitleCandidateCount=raw.titleCandidates.length-out.titleCandidates.length;
  }
  if (Array.isArray(raw.exclusions)) out.exclusions=raw.exclusions.map((x: Row)=>{const r=ref(c,`/series/${encodeURIComponent(x.seriesKey)}`);return {seriesKey:r?.key ?? opaque(x.seriesKey),seriesTitle:r?.title ?? '受保护历史成员',identityProtected:!r,state:enumValue(x.state,['active','revoked'],'active'),reason:PROTECTED,evidence:PROTECTED,createdAt:stamp(x.createdAt),revokedAt:stamp(x.revokedAt),revokedReason:x.revokedReason ? PROTECTED : null};});
  if (Array.isArray(raw.identityConflicts)) out.identityConflicts=raw.identityConflicts.map((x: Row)=>({fromSeriesKey:opaque(x.fromSeriesKey),fromSeriesTitle:'受保护身份冲突',toSeriesKey:null,toSeriesTitle:null,reason:enumValue(x.reason,['superseded','unresolved'],'unresolved'),evidence:null,evidenceProtected:true}));
  if (Array.isArray(raw.series)) out.series=raw.series.map((x: Row)=>({key:x.key,title:x.title,state:x.state,linkState:x.linkState,memberCount:x.memberCount,collectedCount:x.collectedCount,entries:x.entries,evidence:[PROTECTED]}));
  if (Array.isArray(raw.members)) out.members=raw.members.filter((x: Row)=>raw.analysis?.visibility==='real' || !c.hiddenSubjects.has(x.subjectId)).map((x: Row)=>({subjectId:x.subjectId,title:x.title,originalTitle:x.originalTitle,year:x.year,collected:x.collected,relationOnly:x.relationOnly,role:x.role,state:x.state,reasonCode:text(x.reasonCode,'protected'),reason:text(x.reason),viaSubjectId:ref(c,`/subjects/${x.viaSubjectId}`) ? x.viaSubjectId : null,viaRelation:x.viaRelation == null ? null : text(x.viaRelation),item:x.item}));
  if (Array.isArray(raw.related)) out.related=raw.related.map((x: Row)=>({subjectId:x.subjectId,title:x.title,relation:text(x.relation),relationClass:text(x.relationClass,'unknown'),reason:text(x.reason),coveredBy:ref(c,`/subjects/${x.coveredBy}`) ? x.coveredBy : null}));
  if (Array.isArray(raw.mergeCandidates)) out.mergeCandidates=raw.mergeCandidates.filter((x: Row)=>ref(c,`/series/${encodeURIComponent(x.seriesKey)}`)).map((x: Row)=>({seriesKey:x.seriesKey,title:ref(c,`/series/${encodeURIComponent(x.seriesKey)}`)!.title,state:x.state,relations:strings(x.relations)}));
  return out;
}

/** Exported for adversarial DTO tests, not used by internal repair or Verify. */
export function projectEvidence(raw: Row, mode: 'visible' | 'real'): Row {
  const personal = personalHidesActive();
  if (personal) mode = 'visible';
  const applied=personal || (hideNsfwEnabled() && mode !== 'real');
  const presentation={version:1,mode,privacyApplied:applied,note:personal ? '主动隐藏边界生效；完整事实未改动，此入口不解封身份或历史文字。' : applied ? '安全审计摘要；计数仍为完整审计口径。未证明安全的历史证据需要独立确认，Real 指标不会授予证据权限。' : '完整审计证据；可能包含隐藏内容。'};
  if (!applied) return {...raw,...(raw.report ? {report:{...raw.report,presentation}} : {}),presentation};
  if (raw.error) return {error:{code:text(raw.error.code,'protected_request_error'),message:text(raw.error.message,'请求未完成；错误详情可能含受保护审计证据。'),hint:'请检查请求或通过完整审计证据入口复查。',dataIntact:raw.error.dataIntact},presentation};
  const c=context();
  let out: Row;
  if (Array.isArray(raw.issues)) out=report(raw,c);
  else if (Array.isArray(raw.entries)) out=history(raw,c);
  else if ('allowed' in raw && 'preview' in raw) out={kind:text(raw.kind,'protected-action'),label:text(raw.label,'治理预览'),allowed:raw.allowed === true,message:text(raw.message),preview:preview(raw.preview),requiresRealEvidence:!!raw.preview && preview(raw.preview)!.requiresRealEvidence};
  else if (raw.verification && raw.report) out={ok:raw.ok === true,repair:{kind:text(raw.repair?.kind,'protected-action'),label:text(raw.repair?.label,'治理操作')},verification:verification(raw.verification),report:{...report(raw.report,c),presentation}};
  else { out=detail(raw,c); if(raw.series && !Array.isArray(raw.series)) out.series=detail(raw.series,c); if(raw.franchise) out.franchise=detail(raw.franchise,c); }
  return {...out,presentation};
}

export function registerEvidencePresentation(app: FastifyInstance): void {
  const scoped=(r: FastifyRequest)=> /^\/api\/(diagnostics(?:\/|$)|(?:series|franchises)\/:key(?:\/|$))/.test(r.routeOptions.url ?? '');
  app.addHook('preValidation',async request=>{if(scoped(request)) evidenceMode(request);});
  app.addHook('preSerialization',async(request,reply,payload)=>{
    if(!scoped(request) || !payload || typeof payload !== 'object') return payload;
    // Never cache a Real disclosure in a browser/shared HTTP cache.
    reply.header('Cache-Control','no-store').header('Vary','X-Analyzer-Evidence');
    let mode: 'visible'|'real'='visible';
    try { mode=evidenceMode(request); } catch { /* Rejected intent must never authorize error details. */ }
    try { return projectEvidence(payload as Row,mode); }
    catch {
      // A response projection failure after a write is not a rollback. Never emit
      // raw payload or a false successful verification to hide that uncertainty.
      reply.code(503);
      return {error:{code:'evidence_projection_failed',message:'审计响应隐私投影失败，未返回原始证据。',hint:'写入请求可能已提交，请读取当前状态并核对历史，不要直接重试。',dataIntact:['GET','HEAD'].includes(request.method)}};
    }
  });
}
