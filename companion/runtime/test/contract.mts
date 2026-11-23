import { AnalyzerSupervisor, type RuntimeStatus, type RuntimeResult } from '../supervisor.mjs';

// Compile only; never executed and never constructs or starts a service during type checking.
export function uiContract(runtime: AnalyzerSupervisor): [RuntimeStatus, Promise<RuntimeResult>[]] {
  return [runtime.getStatus(), [runtime.startAnalyzer(), runtime.stopAnalyzer(), runtime.openAnalyzer()]];
}
