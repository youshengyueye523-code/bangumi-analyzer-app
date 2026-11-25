import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutoLaunchController } from '../src/state/autoLaunchCore.ts';
import type { AnalyzerStatus, CompanionDriver } from '../src/driver/types.ts';

function makeStatus(partial: Partial<AnalyzerStatus> = {}): AnalyzerStatus {
  return {
    state: 'stopped',
    rawState: 'idle',
    url: null,
    port: null,
    pid: null,
    ownsProcess: false,
    startedAt: null,
    version: '2.0.0',
    dataDir: null,
    package: { state: 'valid', version: '2.0.0', distributionRevision: 5, files: 3250 },
    error: null,
    logs: [],
    ...partial,
  };
}

function makeMockDriver(options: { openFail?: boolean; startFails?: boolean } = {}) {
  const openCalls: string[] = [];
  let startCount = 0;
  let current = makeStatus({ state: 'stopped', rawState: 'idle' });

  const driver: CompanionDriver = {
    kind: 'codex',
    async getStatus() {
      return current;
    },
    async startAnalyzer() {
      startCount += 1;
      if (options.startFails) {
        current = makeStatus({
          state: 'error',
          rawState: 'failed',
          error: { code: 'START_FAILED', message: 'failed' },
        });
        return current;
      }
      current = makeStatus({
        state: 'running',
        rawState: 'ready',
        ownsProcess: true,
        url: 'http://127.0.0.1:19876/',
        port: 19876,
        startedAt: Date.now(),
      });
      return current;
    },
    async stopAnalyzer() {
      current = makeStatus({ state: 'stopped', rawState: 'stopped', url: null, port: null, ownsProcess: false });
      return current;
    },
    async openAnalyzer(route = '/') {
      openCalls.push(route);
      if (options.openFail) {
        return {
          opened: false,
          url: `http://127.0.0.1:19876${route}`,
          error: { code: 'OPEN_FAILED', message: 'cannot spawn browser', hint: 'copy url manually' },
        };
      }
      return { opened: true, url: `http://127.0.0.1:19876${route}` };
    },
  };

  return {
    driver,
    openCalls,
    getStartCount: () => startCount,
    getCurrent: () => current,
    setCurrent: (next: AnalyzerStatus) => {
      current = next;
    },
  };
}

test('autoLaunch coordinator (F04)', async (t) => {
  await t.test('cold starts once and opens browser exactly once across subsequent status polls', async () => {
    const { driver, openCalls, getStartCount, getCurrent } = makeMockDriver();
    const ctrl = createAutoLaunchController();

    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: makeStatus({ state: 'stopped', rawState: 'idle' }),
    });

    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });

    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });

    assert.equal(getStartCount(), 1);
    assert.deepEqual(openCalls, ['/']);
  });

  await t.test('continues autoOpen even if user skips splash before runtime finishes starting', async () => {
    const { driver, openCalls, getCurrent } = makeMockDriver();
    const ctrl = createAutoLaunchController();

    await ctrl.sync({
      enabled: true,
      screen: 'splash',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: makeStatus({ state: 'stopped', rawState: 'idle' }),
    });

    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });

    assert.deepEqual(openCalls, ['/']);
  });

  await t.test('never opens automatically when autoOpen is disabled', async () => {
    const { driver, openCalls, getCurrent } = makeMockDriver();
    const ctrl = createAutoLaunchController();

    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: false,
      firstRunCompleted: true,
      driver,
      status: makeStatus({ state: 'stopped' }),
    });
    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: false,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });

    assert.deepEqual(openCalls, []);
  });

  await t.test('opens once again when stopped and manually restarted, and honors allowColdAutoStart=false', async () => {
    const { driver, openCalls, getStartCount, getCurrent, setCurrent } = makeMockDriver();
    const ctrl = createAutoLaunchController();

    await ctrl.sync({
      enabled: true,
      allowColdAutoStart: false,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: makeStatus({ state: 'stopped' }),
    });
    assert.equal(getStartCount(), 0);
    assert.deepEqual(openCalls, []);

    ctrl.armAutoOpenForNextReady();
    await driver.startAnalyzer();
    await ctrl.sync({
      enabled: true,
      allowColdAutoStart: false,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });
    assert.deepEqual(openCalls, ['/']);

    await driver.stopAnalyzer();
    await ctrl.sync({
      enabled: true,
      allowColdAutoStart: false,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });

    ctrl.armAutoOpenForNextReady();
    await driver.startAnalyzer();
    await ctrl.sync({
      enabled: true,
      allowColdAutoStart: false,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });
    setCurrent({ ...getCurrent(), startedAt: getCurrent().startedAt });
    await ctrl.sync({
      enabled: true,
      allowColdAutoStart: false,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });
    assert.deepEqual(openCalls, ['/', '/']);
  });

  await t.test('surfaces OPEN_FAILED error cleanly instead of silently succeeding or looping', async () => {
    const { driver, openCalls, getCurrent } = makeMockDriver({ openFail: true });
    const ctrl = createAutoLaunchController();

    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: makeStatus({ state: 'stopped' }),
    });
    await ctrl.sync({
      enabled: true,
      screen: 'home',
      autoStart: true,
      autoOpen: true,
      firstRunCompleted: true,
      driver,
      status: getCurrent(),
    });

    assert.deepEqual(openCalls, ['/']);
    assert.equal(ctrl.getSnapshot().lastError?.code, 'OPEN_FAILED');
  });
});
