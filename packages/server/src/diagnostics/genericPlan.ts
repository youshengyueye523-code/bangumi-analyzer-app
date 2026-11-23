/** Bind only the legacy global recompute actions, not governance or BATCH-03 plans. */
import { ApiError, type DiagnosticIssue } from '@bangumi-analyzer/shared';
import { all, dataVersion, schemaVersion } from '../db/index.js';
import { planEntityLifecycle, type EntityEventWrite } from '../db/series.js';
import { digest, fingerprint } from './stateFingerprint.js';
import { titleCandidatesForMutation } from '../db/titleCandidates.js';
import { supportsQualitySchema } from '../db/schema.js';

// This action really is GLOBAL. Do not pretend that issue.affected is its write domain.
const INPUTS = ['subjects', 'collections', 'subject_relations', 'subject_staff', 'series', 'series_members',
  'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'entity_aliases',
  'entity_events', 'candidate_decisions', 'franchise_member_exclusions', 'series_legacy_snapshot', 'meta'] as const;
export const GENERIC_WRITE_SET = [
  'subjects：仅 series_key / series_source 归属投影',
  'series_entities / series_entity_members：身份、名称候选与成员派生；保留人工治理',
  'franchise_entities / franchise_series：家族派生；保留冻结成员及排除',
  'entity_aliases：生命周期重定向、退役；entity_events：只追加系统事件，历史不改写',
  'meta：仅统一 mutation 的版本及变更记录',
] as const;

export function genericRecomputePlan() {
  const schema = schemaVersion();
  if (!supportsQualitySchema(schema)) throw new ApiError('通用重算计划的 Schema 未核验', {code:'generic_plan_unassessed',status:409,dataIntact:true});
  const inputs = [...INPUTS, ...(schema>=14?['collection_rating_history']:[]),
    ...(schema>=15?['franchise_member_assignments','subject_user_hides']:[])];
  const tables = inputs.map(table => ({table,
    rows: Number(all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n),
    hash: fingerprint(`SELECT * FROM ${table} ORDER BY rowid`)}));
  const lifecycle = planEntityLifecycle();
  // Generation 3 also binds exact uniform mutation metadata enforcement.
  const identity = {version:3, schema, schemaFingerprint:fingerprint('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'),
    dataVersion:dataVersion(), tables, lifecycle, writes:GENERIC_WRITE_SET};
  return {token:`global-v1:${digest(identity)}`, tables, lifecycle};
}

export function bindGenericRecomputeActions(issues: DiagnosticIssue[]): void {
  // A and BATCH-03 have their own exact target+value tokens and must never be rebound.
  const actions = issues.flatMap(i => i.actions).filter(a => a.kind === 'repair' && a.repairKind === 'recompute-derived' && !a.target && !a.value);
  if (!actions.length) return;
  const plan = genericRecomputePlan();
  for (const action of actions) {
    if (action.kind !== 'repair') continue;
    action.value = plan.token;
    action.preview = {...action.preview,
      directlyChanges:[...GENERIC_WRITE_SET],
      chain:[...action.preview.chain,
        {layer:'source',label:'全局重算绑定',detail:`计划 ${plan.token}；当前完整来源、成员、治理、投影及代次绑定；任意输入改变须重新预览。`},
        {layer:'projection',label:'实际全局范围',detail:plan.tables.map(t=>`${t.table}=${t.rows}`).join(' / ')},
        {layer:'projection',label:'生命周期计划',detail:JSON.stringify(plan.lifecycle)},
      ]};
  }
}

export function assertGenericRecomputePlan(token: string | undefined): void {
  if (!token || token !== genericRecomputePlan().token) throw new ApiError('通用重算预览已失效，请重新检测并确认范围', {
    code:'generic_recompute_plan_stale',status:409,dataIntact:true,
  });
}

/** The declared write set is checked after execution, not merely printed in a preview. */
export function genericProtectedState(historyThrough?: string): string {
  const dbTables = ['collections','subject_relations','subject_staff','series','series_members',
    'candidate_decisions','franchise_member_exclusions','series_legacy_snapshot',
    'sync_runs','sync_stage','translation_jobs','profile_reports','profile_snapshots'];
  const dbColumns = all<{name:string}>('PRAGMA table_info(subjects)').map(c=>c.name).filter(c=>!['series_key','series_source'].includes(c));
  const manual = ['series_entities','franchise_entities'].map(t => all<Record<string,unknown>>(
    `SELECT id,key,title,title_state,title_source,title_candidates FROM ${t} WHERE title_state='manual' ORDER BY id`,
  ).map(row=>{
    const candidates=titleCandidatesForMutation(String(row.title_candidates));
    return {...row,title_candidates:candidates===null?row.title_candidates:candidates.filter(c=>c.source==='manual')};
  }));
  return digest([
    ...dbTables.map(t=>fingerprint(`SELECT * FROM ${t} ORDER BY rowid`)),
    fingerprint(`SELECT ${dbColumns.map(c=>`"${c}"`).join(',')} FROM subjects ORDER BY id`),
    fingerprint(`SELECT * FROM meta WHERE key NOT IN ('data_version','last_mutation_scope','last_mutation_at','last_mutation_detail') ORDER BY key`),
    manual,
    historyThrough === undefined ? null : fingerprint('SELECT * FROM entity_events WHERE id<=:id ORDER BY id',{id:historyThrough}),
  ]);
}

/** Only the engine's intentional system appends are authorized, including exact payload/ID.
 * Comparing the complete tail also catches indirect SQL/trigger writes and deleted appends.
 */
export function genericEventsPreserved(expected: EntityEventWrite[], historyThrough: string): boolean {
  const systemKinds: Record<string, readonly string[]> = {
    series: ['created','title_proposed','title_changed','restored','merged','split','unmatched',
      'legacy_merged','legacy_split','candidate_reopened','alias_redirected','alias_retired'],
    franchise: ['created','candidate_reopened','conflict_resolved','candidate_member','conflict',
      'conflict_unmatched','alias_redirected','alias_retired'],
    legacy: ['unmapped'],
  };
  for (const event of expected) {
    if (!Number.isSafeInteger(event.id) || !Number.isSafeInteger(event.entity_id) ||
      !systemKinds[event.entity_kind]?.includes(event.kind)) return false;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(event.payload) as Record<string, unknown>; } catch { return false; }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
      Object.hasOwn(payload, 'trigger') || payload.toState === 'manual') return false;
  }
  const rows = all<EntityEventWrite>('SELECT * FROM entity_events WHERE id>:id ORDER BY id', {id:historyThrough});
  const ordered = (events: EntityEventWrite[]) => events.map(e =>
    [String(e.id),e.entity_kind,String(e.entity_id),e.kind,e.payload,e.created_at]);
  return digest(ordered(rows)) === digest(ordered(expected));
}
