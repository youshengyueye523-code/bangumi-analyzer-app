import { useEffect, useState } from 'react';
import type { DiagnosticsFreshness } from '@bangumi-analyzer/shared';

/** One deadline timer for the open view, no network polling or background detector. */
export function useDiagnosticExpired(freshness: DiagnosticsFreshness | undefined): boolean {
  const [, tick] = useState(0);
  const deadline = freshness ? Date.parse(freshness.validUntil) : NaN;
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const delay = deadline - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.min(delay + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [deadline]);
  return !!freshness && (freshness.status === 'expired' || !Number.isFinite(deadline) || Date.now() >= deadline || Date.now() < Date.parse(freshness.observedAt));
}
