import type { ProfileAiOutput, ProfileAiReport } from '@bangumi-analyzer/shared';
import { parseJsonColumn, toJson } from '../util.js';
import { all, one, run } from './index.js';

interface ReportRow {
  id: number;
  snapshot_id: number | null;
  provider: string;
  model: string;
  dataset_hash: string;
  output: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

function mapReport(row: ReportRow, currentHash: string): ProfileAiReport {
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    provider: row.provider,
    model: row.model,
    datasetHash: row.dataset_hash,
    upToDate: row.dataset_hash === currentHash,
    output: parseJsonColumn<ProfileAiOutput>(row.output, { sections: [], verdict: '', uncertainties: [], surprises: [] }),
    usage: {
      promptTokens: row.prompt_tokens === null ? null : Number(row.prompt_tokens),
      completionTokens: row.completion_tokens === null ? null : Number(row.completion_tokens),
    },
  };
}

export interface SaveReportInput {
  snapshotId: number | null;
  provider: string;
  model: string;
  datasetHash: string;
  output: ProfileAiOutput;
  promptTokens: number | null;
  completionTokens: number | null;
}

export function saveReport(input: SaveReportInput): number {
  const result = run(
    `INSERT INTO profile_reports (
       snapshot_id, provider, model, dataset_hash, output,
       prompt_tokens, completion_tokens, created_at
     ) VALUES (
       :snapshotId, :provider, :model, :datasetHash, :output,
       :promptTokens, :completionTokens, :createdAt
     )`,
    {
      snapshotId: input.snapshotId,
      provider: input.provider,
      model: input.model,
      datasetHash: input.datasetHash,
      output: toJson(input.output),
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      createdAt: new Date().toISOString(),
    },
  );
  return result.lastInsertRowid;
}

export function latestReport(currentHash: string): ProfileAiReport | null {
  const row = one<ReportRow>(
    'SELECT * FROM profile_reports ORDER BY created_at DESC, id DESC LIMIT 1',
  );
  return row ? mapReport(row, currentHash) : null;
}

export function reportByHash(hash: string): ProfileAiReport | null {
  const row = one<ReportRow>(
    'SELECT * FROM profile_reports WHERE dataset_hash = :hash ORDER BY id DESC LIMIT 1',
    { hash },
  );
  return row ? mapReport(row, hash) : null;
}

export function reportById(id: number, currentHash: string): ProfileAiReport | null {
  const row = one<ReportRow>('SELECT * FROM profile_reports WHERE id = ?', [id]);
  return row ? mapReport(row, currentHash) : null;
}

export function reportHistory(currentHash: string) {
  return all<Pick<ReportRow, 'id' | 'created_at' | 'model' | 'dataset_hash'>>(
    'SELECT id,created_at,model,dataset_hash FROM profile_reports ORDER BY created_at DESC,id DESC',
  ).map(row => ({
    id: Number(row.id),
    createdAt: row.created_at,
    model: row.model,
    upToDate: row.dataset_hash === currentHash,
  }));
}

export function listReports(limit = 20): ReportRow[] {
  return all<ReportRow>('SELECT * FROM profile_reports ORDER BY id DESC LIMIT :limit', { limit });
}
