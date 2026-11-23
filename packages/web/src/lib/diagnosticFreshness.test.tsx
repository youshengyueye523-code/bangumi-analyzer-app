import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDiagnosticExpired } from './diagnosticFreshness.js';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('观察期限单次计时到期，不发网络或扫描；新观察恢复',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  const snapshot={status:'snapshot' as const,reason:null,observedAt:'2026-11-08T00:00:00Z',validUntil:'2026-11-08T00:01:00Z',boundary:'snapshot only'};
  const {result,rerender}=renderHook(({f})=>useDiagnosticExpired(f),{initialProps:{f:snapshot}});expect(result.current).toBe(false);
  act(()=>vi.advanceTimersByTime(60_001));expect(result.current).toBe(true);
  rerender({f:{...snapshot,observedAt:'2026-11-08T00:01:00Z',validUntil:'2026-11-08T00:02:00Z'}});expect(result.current).toBe(false);
});
