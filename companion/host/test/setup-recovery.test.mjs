import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyBangumiNetworkError,
  DEFAULT_R2_ZIP,
  extractVerifiedPackage,
  inspectSessionLock,
  readCompanionState,
  reconnectExistingInstall,
  SetupError,
  validateInstallDir,
} from '../setup-service.mjs';

const WORK_BASE = join(process.cwd(), 'companion/host/.work');

test('Stage 3.1: inspectSessionLock distinguishes none, owned_by_self, active_external, and stale', async () => {
  await mkdir(WORK_BASE, { recursive: true });
  const dir = await mkdtemp(join(WORK_BASE, 'lock-test-'));
  try {
    // 1. No lock
    const none = await inspectSessionLock(dir);
    assert.equal(none.locked, false);
    assert.equal(none.kind, 'none');

    // 2. Owned by self
    const lockFile = join(dir, '.analyzer-session.json');
    await writeFile(lockFile, JSON.stringify({ launcherPid: process.pid, servicePid: 999999 }));
    const self = await inspectSessionLock(dir);
    assert.equal(self.locked, true);
    assert.equal(self.kind, 'owned_by_self');

    // 3. Stale lock (dead PIDs)
    await writeFile(lockFile, JSON.stringify({ launcherPid: 999991, servicePid: 999992, url: 'http://127.0.0.1:65432/' }));
    const stale = await inspectSessionLock(dir);
    assert.equal(stale.locked, true);
    assert.equal(stale.kind, 'stale');

    const staleVerdict = await validateInstallDir(dir);
    assert.equal(staleVerdict.level, 'warn');
    assert.ok(staleVerdict.reasons.some((r) => r.includes('失效会话锁')));

    // 4. Active external lock (spawn a real sleeper child process)
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true });
    try {
      await writeFile(lockFile, JSON.stringify({ launcherPid: sleeper.pid, servicePid: sleeper.pid }));
      const active = await inspectSessionLock(dir);
      assert.equal(active.locked, true);
      assert.equal(active.kind, 'active_external');

      const activeVerdict = await validateInstallDir(dir);
      assert.equal(activeVerdict.level, 'error');
      assert.ok(activeVerdict.reasons.some((r) => r.includes('会话锁有效')));

      // extractVerifiedPackage must refuse SESSION_LOCKED and MUST NOT delete the live lock!
      await assert.rejects(
        () => extractVerifiedPackage(dir, DEFAULT_R2_ZIP),
        (err) => err instanceof SetupError && err.code === 'SESSION_LOCKED',
      );
      assert.equal(existsSync(lockFile), true, 'active external lock must remain untouched');
    } finally {
      sleeper.kill();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Stage 3.1: extractVerifiedPackage protects unrelated non-empty dir, recovers stale lock & partial install preserving data/', async () => {
  await mkdir(WORK_BASE, { recursive: true });
  const unrelated = await mkdtemp(join(WORK_BASE, 'unrelated-'));
  const target = await mkdtemp(join(WORK_BASE, 'recover-'));
  try {
    // Unrelated user files must NEVER be overwritten or deleted
    await writeFile(join(unrelated, 'my-notes.txt'), 'precious user file');
    await assert.rejects(
      () => extractVerifiedPackage(unrelated, DEFAULT_R2_ZIP),
      (err) => err instanceof SetupError && err.code === 'DIR_NOT_EMPTY',
    );
    assert.equal(await readFile(join(unrelated, 'my-notes.txt'), 'utf8'), 'precious user file');

    // Simulate interrupted partial install + stale crash lock + existing user data/
    await mkdir(join(target, 'data'), { recursive: true });
    await writeFile(join(target, 'data', 'user-marker.txt'), 'keep-me-intact');
    await writeFile(join(target, 'service.mjs'), '// corrupted partial file');
    await writeFile(join(target, '.analyzer-session.json'), JSON.stringify({ launcherPid: 999993, servicePid: 999994 }));

    const installed = await extractVerifiedPackage(target, DEFAULT_R2_ZIP);
    assert.equal(installed, target);
    assert.equal(existsSync(join(target, '.analyzer-session.json')), false, 'stale lock cleaned');
    assert.equal(await readFile(join(target, 'data', 'user-marker.txt'), 'utf8'), 'keep-me-intact', 'user data preserved');

    // Idempotent second call succeeds and still preserves data/
    const again = await extractVerifiedPackage(target, DEFAULT_R2_ZIP);
    assert.equal(again, target);
    assert.equal(await readFile(join(target, 'data', 'user-marker.txt'), 'utf8'), 'keep-me-intact');
  } finally {
    await rm(unrelated, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('P0.5: reconnectExistingInstall rejects unrelated dirs and safely reconnects valid Analyzer dir without copying secrets', async () => {
  await mkdir(WORK_BASE, { recursive: true });
  const unrelated = await mkdtemp(join(WORK_BASE, 'reconnect-bad-'));
  const validDir = await mkdtemp(join(WORK_BASE, 'reconnect-good-'));
  const compHome = await mkdtemp(join(WORK_BASE, 'reconnect-home-'));
  try {
    await writeFile(join(unrelated, 'notes.txt'), 'unrelated');
    const bad = await reconnectExistingInstall(unrelated, compHome);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'NOT_ANALYZER_DIR');

    await mkdir(join(validDir, 'runtime'), { recursive: true });
    await mkdir(join(validDir, 'packages', 'server', 'dist'), { recursive: true });
    await mkdir(join(validDir, 'data'), { recursive: true });
    await writeFile(join(validDir, 'release.json'), JSON.stringify({ product: 'Bangumi Analyzer', version: '2.0.0', distributionRevision: 2 }));
    await writeFile(join(validDir, 'checksums.json'), '{}');
    await writeFile(join(validDir, 'runtime', 'node.exe'), 'stub');
    await writeFile(join(validDir, 'packages', 'server', 'dist', 'index.js'), 'stub');
    await writeFile(join(validDir, 'data', 'bangumi.db'), 'immutable-db-bytes');
    await writeFile(join(validDir, 'data', 'config.json'), JSON.stringify({ username: 'veteran', nickname: '老用户', token: 'secret-tok', ai: { apiKey: 'secret-key', model: 'm1' } }));

    const res = await reconnectExistingInstall(validDir, compHome);
    assert.equal(res.ok, true);
    assert.equal(res.hasDatabase, true);
    assert.equal(res.state.firstRunCompleted, true);
    assert.equal(res.state.installDir, validDir);
    assert.equal(res.state.nickname, '老用户');
    assert.equal('token' in res.state, false);
    assert.equal('aiKey' in res.state, false);
    assert.equal(await readFile(join(validDir, 'data', 'bangumi.db'), 'utf8'), 'immutable-db-bytes');
    const persisted = await readCompanionState(compHome);
    assert.equal(persisted.firstRunCompleted, true);
    assert.equal(persisted.installDir, validDir);
  } finally {
    await rm(unrelated, { recursive: true, force: true });
    await rm(validDir, { recursive: true, force: true });
    await rm(compHome, { recursive: true, force: true });
  }
});

test('P2.4: classifyBangumiNetworkError distinguishes DNS, timeout, TLS, and generic connection errors cleanly', () => {
  assert.equal(classifyBangumiNetworkError({ cause: { code: 'ENOTFOUND' } }).code, 'DNS_FAILED');
  assert.equal(classifyBangumiNetworkError({ name: 'TimeoutError' }).code, 'TIMEOUT');
  assert.equal(classifyBangumiNetworkError({ cause: { code: 'CERT_HAS_EXPIRED' } }).code, 'TLS_ERROR');
  const net = classifyBangumiNetworkError({ cause: { code: 'ECONNREFUSED' } });
  assert.equal(net.code, 'NETWORK_FAILED');
  assert.match(net.message, /软件已正常启动，但目前无法连接 Bangumi/);
});
