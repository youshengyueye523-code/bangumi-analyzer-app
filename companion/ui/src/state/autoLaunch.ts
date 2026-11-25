import { useEffect, useSyncExternalStore } from 'react';
import { startAndAwaitReady, type AnalyzerError, type AnalyzerStatus, type CompanionDriver } from '../driver';
import {
  createAutoLaunchController,
  type AutoLaunchController,
  type AutoLaunchHooks,
  type AutoLaunchScreen,
  type AutoLaunchSnapshot,
} from './autoLaunchCore';
import { log, toast } from './feedback';
import { playChime } from './sound';
import type { Screen } from './flow';

export { createAutoLaunchController };
export type { AutoLaunchController, AutoLaunchHooks, AutoLaunchScreen, AutoLaunchSnapshot };

export const defaultAutoLaunchController = createAutoLaunchController({
  log,
  toast,
  playChime,
  startAndAwaitReady,
});

export function armAutoOpenForNextReady() {
  defaultAutoLaunchController.armAutoOpenForNextReady();
}

export function disarmAutoOpen() {
  defaultAutoLaunchController.disarmAutoOpen();
}

export function markColdAutoStartHandled() {
  defaultAutoLaunchController.markColdAutoStartHandled();
}

export function clearAutoOpenError() {
  defaultAutoLaunchController.clearError();
}

export function resetAutoLaunchForTest() {
  defaultAutoLaunchController.resetForTest();
}

export function useAutoOpenError(): AnalyzerError | null {
  return useSyncExternalStore(
    defaultAutoLaunchController.subscribe,
    () => defaultAutoLaunchController.getSnapshot().lastError,
  );
}

export function useAutoLaunchCoordinator(params: {
  enabled: boolean;
  allowColdAutoStart?: boolean;
  screen: Screen;
  autoStart: boolean;
  autoOpen: boolean;
  firstRunCompleted: boolean;
  driver: CompanionDriver;
  status: AnalyzerStatus;
}) {
  const { enabled, allowColdAutoStart, screen, autoStart, autoOpen, firstRunCompleted, driver, status } = params;

  useEffect(() => {
    void defaultAutoLaunchController.sync({
      enabled,
      allowColdAutoStart,
      screen,
      autoStart,
      autoOpen,
      firstRunCompleted,
      driver,
      status,
    });
  }, [enabled, allowColdAutoStart, screen, autoStart, autoOpen, firstRunCompleted, driver, status, status.state, status.url]);
}
