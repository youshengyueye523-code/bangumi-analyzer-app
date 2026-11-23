import type { ProfileDataset, ProfileSnapshotSummary } from '@bangumi-analyzer/shared';
import { parseJsonColumn, toJson } from '../util.js';
import { all, one, run } from './index.js';

/** 快照里保存的作品状态：[收藏状态, 我的评分] */
export type SnapshotMember = [number, number];

export interface SnapshotRecord extends ProfileSnapshotSummary {
  /** Rank 复盘的候选清单（可能为空） */
  candidateIds: number[] | null;
  dataset: ProfileDataset;
  members: Record<string, SnapshotMember>;
}

interface SnapshotRow {
  id: number;
  stage_label: string;
  note: string;
  source: string;
  rank_from: number | null;
  rank_to: number | null;
  candidate_ids: string | null;
  created_at: string;
  collection_count: number;
  rated_count: number;
  average_rate: number | null;
  dataset: string;
  members: string;
}

function candidateIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0))];
  return ids.length > 0 ? ids : null;
}

function mapSummary(row: SnapshotRow): ProfileSnapshotSummary {
  const candidates = candidateIds(parseJsonColumn<unknown>(row.candidate_ids, null));
  const dataset = parseJsonColumn<{ visibility?: unknown } | null>(row.dataset, null);
  return {
    visibility: dataset?.visibility === 'real' || dataset?.visibility === 'visible' ? dataset.visibility : null,
    id: Number(row.id),
    stageLabel: row.stage_label,
    note: row.note,
    source: row.source,
    rankFrom: row.rank_from === null ? null : Number(row.rank_from),
    rankTo: row.rank_to === null ? null : Number(row.rank_to),
    createdAt: row.created_at,
    collectionCount: Number(row.collection_count),
    ratedCount: Number(row.rated_count),
    averageRate: row.average_rate === null ? null : Number(row.average_rate),
    candidateCount: Array.isArray(candidates) ? candidates.length : null,
    hasCandidateList: Array.isArray(candidates) && candidates.length > 0,
  };
}

export interface CreateSnapshotInput {
  stageLabel: string;
  note?: string;
  source?: string;
  rankFrom?: number | null;
  rankTo?: number | null;
  candidateIds?: number[] | null;
  dataset: ProfileDataset;
  members: Record<string, SnapshotMember>;
}

export function createSnapshot(input: CreateSnapshotInput): ProfileSnapshotSummary {
  const rated = input.dataset.sample.rated;
  const candidates = candidateIds(input.candidateIds);
  const result = run(
    `INSERT INTO profile_snapshots (
       stage_label, note, source, rank_from, rank_to, candidate_ids, created_at,
       collection_count, rated_count, average_rate, dataset, members
     ) VALUES (
       :stageLabel, :note, :source, :rankFrom, :rankTo, :candidateIds, :createdAt,
       :collectionCount, :ratedCount, :averageRate, :dataset, :members
     )`,
    {
      stageLabel: input.stageLabel,
      note: input.note ?? '',
      source: input.source ?? '',
      rankFrom: input.rankFrom ?? null,
      rankTo: input.rankTo ?? null,
      candidateIds: candidates ? toJson(candidates) : null,
      createdAt: new Date().toISOString(),
      collectionCount: input.dataset.sample.total,
      ratedCount: rated,
      averageRate: input.dataset.basics.averageRate,
      dataset: toJson(input.dataset),
      members: toJson(input.members),
    },
  );
  const snapshot = getSnapshot(result.lastInsertRowid);
  if (!snapshot) throw new Error('快照写入失败');
  const { dataset: _dataset, members: _members, candidateIds: _candidates, ...summary } = snapshot;
  return summary;
}

export function listSnapshots(): ProfileSnapshotSummary[] {
  return all<SnapshotRow>(
    'SELECT * FROM profile_snapshots ORDER BY created_at DESC, id DESC',
  ).map(mapSummary);
}

export function getSnapshot(id: number): SnapshotRecord | null {
  const row = one<SnapshotRow>('SELECT * FROM profile_snapshots WHERE id = :id', { id });
  if (!row) return null;
  return {
    ...mapSummary(row),
    candidateIds: candidateIds(parseJsonColumn<unknown>(row.candidate_ids, null)),
    dataset: parseJsonColumn<ProfileDataset>(row.dataset, {} as ProfileDataset),
    members: parseJsonColumn<Record<string, SnapshotMember>>(row.members, {}),
  };
}

export function latestSnapshot(): SnapshotRecord | null {
  const row = one<SnapshotRow>('SELECT * FROM profile_snapshots ORDER BY created_at DESC, id DESC');
  return row ? getSnapshot(Number(row.id)) : null;
}

export function deleteSnapshot(id: number): boolean {
  const result = run('DELETE FROM profile_snapshots WHERE id = :id', { id });
  return result.changes > 0;
}

/** 用当前收藏数据生成快照成员表（状态 + 评分）。 */
export function currentMembers(): Record<string, SnapshotMember> {
  const rows = all<{ subject_id: number; type: number; rate: number }>(
    'SELECT subject_id, type, effective_personal_rate(type,rate) AS rate FROM collections',
  );
  const members: Record<string, SnapshotMember> = {};
  for (const row of rows) {
    members[String(row.subject_id)] = [Number(row.type), Number(row.rate)];
  }
  return members;
}
