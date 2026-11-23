import { all, one, run, schemaVersion } from './index.js';
import { franchiseAverageRateSql } from './franchiseAverage.js';
import { parseJsonColumn, toJson } from '../util.js';

export function activeManualAssignment(seriesId: number): { id: number; franchise_id: number } | undefined {
  if (schemaVersion() < 15) return undefined;
  return one('SELECT id,franchise_id FROM franchise_member_assignments WHERE series_id=? AND revoked_at IS NULL', [seriesId]);
}

/** Automatic candidate evidence is retained separately, never promoted by the resolver. */
export function projectManualFranchiseLinks(franchiseId?: number, rebuiltAutomaticFamilies?: ReadonlySet<number>): void {
  if (schemaVersion() < 15) return;
  for (const a of all<{ id: number; franchise_id: number; series_id: number; series_state: string }>(
    `SELECT a.id,a.franchise_id,a.series_id,e.state AS series_state
       FROM franchise_member_assignments a JOIN franchise_entities f ON f.id=a.franchise_id
       JOIN series_entities e ON e.id=a.series_id
       WHERE a.revoked_at IS NULL AND f.state<>'stale'
       ${franchiseId === undefined ? '' : 'AND a.franchise_id=:id'} ORDER BY a.id`,
    franchiseId === undefined ? undefined : { id: franchiseId },
  )) {
    const key={ f:a.franchise_id, s:a.series_id };
    const old=one<{state:string;evidence:string}>('SELECT state,evidence FROM franchise_series WHERE franchise_id=:f AND series_id=:s',key);
    const prior=parseJsonColumn<{ manualAssignment?:number; automatic?:{state:string;evidence:string} }>(old?.evidence, {}) ?? {};
    const priorAutomatic = prior.manualAssignment===a.id ? prior.automatic : old;
    // An unmatched family keeps its manual edge, not a now-unobserved automatic suggestion.
    // The original suggestion remains in the assignment's evidence/history.
    const automatic = rebuiltAutomaticFamilies && !rebuiltAutomaticFamilies.has(a.franchise_id)
      && priorAutomatic && ['candidate','provisional'].includes(priorAutomatic.state)
      ? undefined : priorAutomatic;
    const state=a.series_state==='stale'?'conflict':'confirmed';
    const evidence=toJson({manualAssignment:a.id,...(automatic?{automatic}:{})});
    run(`INSERT INTO franchise_series(franchise_id,series_id,state,evidence) VALUES(:f,:s,:state,:evidence)
         ON CONFLICT(franchise_id,series_id) DO UPDATE SET state=excluded.state,evidence=excluded.evidence
         WHERE state IS NOT excluded.state OR evidence IS NOT excluded.evidence`,{...key,state,evidence});
  }
}

export function releaseManualProjection(franchiseId: number, seriesId: number, assignmentId: number): void {
  const key={ f:franchiseId,s:seriesId };
  const row=one<{evidence:string}>('SELECT evidence FROM franchise_series WHERE franchise_id=:f AND series_id=:s',key);
  const evidence=parseJsonColumn<{manualAssignment?:number;automatic?:{state:string;evidence:string}}>(row?.evidence,{}) ?? {};
  if (evidence.manualAssignment!==assignmentId) return;
  const live=one("SELECT 1 FROM series_entities WHERE id=? AND state<>'stale'",[seriesId]);
  if (live && evidence.automatic && ['candidate','provisional'].includes(evidence.automatic.state)) {
    run('UPDATE franchise_series SET state=:state,evidence=:evidence WHERE franchise_id=:f AND series_id=:s',{...key,...evidence.automatic});
  } else run('DELETE FROM franchise_series WHERE franchise_id=:f AND series_id=:s',key);
}

/** Target only; same deduplicated primary cohort as the engine. */
export function refreshManualFranchiseCounters(id: number, timestamp: string): void {
  const members=`FROM franchise_series fs JOIN series_entities e ON e.id=fs.series_id AND e.state<>'stale'
    JOIN series_entity_members m ON m.series_id=e.id AND m.role='primary'
    LEFT JOIN collections c ON c.subject_id=m.subject_id WHERE fs.franchise_id=:id`;
  run(`UPDATE franchise_entities AS f SET
    series_count=(SELECT COUNT(*) FROM franchise_series WHERE franchise_id=:id),
    confirmed_series_count=(SELECT COUNT(*) FROM franchise_series WHERE franchise_id=:id AND state IN ('confirmed','provisional')),
    candidate_series_count=(SELECT COUNT(*) FROM franchise_series WHERE franchise_id=:id AND state='candidate'),
    conflict_series_count=(SELECT COUNT(*) FROM franchise_series WHERE franchise_id=:id AND state='conflict'),
    known_count=(SELECT COUNT(DISTINCT m.subject_id) ${members}),
    collected_count=(SELECT COUNT(DISTINCT c.subject_id) ${members}),
    average_rate=${franchiseAverageRateSql('f','real')},
    first_year=(SELECT MIN(e.first_year) FROM franchise_series fs JOIN series_entities e ON e.id=fs.series_id AND e.state<>'stale' WHERE fs.franchise_id=:id),
    last_year=(SELECT MAX(e.last_year) FROM franchise_series fs JOIN series_entities e ON e.id=fs.series_id AND e.state<>'stale' WHERE fs.franchise_id=:id),
    revision=revision+1,updated_at=:timestamp WHERE id=:id`,{id,timestamp});
}
