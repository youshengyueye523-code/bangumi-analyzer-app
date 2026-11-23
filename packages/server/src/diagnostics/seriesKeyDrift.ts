import { all, one } from '../db/index.js';

// A missing live destination and a live member's mismatched cache can describe
// the same subject. Keep both predicates but count/sample the subject only once.
const driftedSubjects = `FROM subjects s
  WHERE (s.series_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
    WHERE m.subject_id = s.id AND m.role = 'primary' AND e.state <> 'stale' AND e.key = s.series_key
  )) OR (
    EXISTS (SELECT 1 FROM collections c WHERE c.subject_id = s.id)
    AND EXISTS (
      SELECT 1 FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
      WHERE m.subject_id = s.id AND m.role = 'primary' AND e.state <> 'stale' AND e.key IS NOT s.series_key
    )
  )`;

export function countSeriesKeyDrift(): number {
  return Number(one<{ n: number }>(`SELECT COUNT(*) AS n ${driftedSubjects}`)?.n ?? 0);
}

export function sampleSeriesKeyDrift() {
  return all<{ id: number; title: string; actual: string | null; expected: string | null }>(
    `SELECT s.id, COALESCE(NULLIF(s.name_cn, ''), s.name) AS title, s.series_key AS actual,
            (SELECT e.key FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
             WHERE m.subject_id = s.id AND m.role = 'primary' AND e.state <> 'stale'
               AND e.key IS NOT s.series_key ORDER BY e.id LIMIT 1) AS expected
      ${driftedSubjects} ORDER BY s.id LIMIT 5`,
  );
}
