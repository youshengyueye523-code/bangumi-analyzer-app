/** Existing positive Repair fixtures now supply the required legacy-global plan.
 * This is request setup, never an oracle. D's rejection tests call the real entry directly.
 */
import type { DiagnosticsRepairRequest } from '@bangumi-analyzer/shared';
import { genericRecomputePlan } from '../src/diagnostics/genericPlan.js';
import { runDiagnosticsRepair as execute } from '../src/diagnostics/repair.js';
export function runDiagnosticsRepair(request:DiagnosticsRepairRequest){
  return execute(request.kind==='recompute-derived' && !request.value && !request.target
    ? {...request,value:genericRecomputePlan().token} : request);
}
