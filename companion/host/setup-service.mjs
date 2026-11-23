import { spawnSync } from 'node:child_process';
import { constants as fsConst, existsSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { freemem, homedir, release, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkPackage, normalPath, sha256 } from '../runtime/package-check.mjs';

export class SetupError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function probeLocalHealth(url) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) return Promise.resolve(false);
  const parsed = new URL(url);
  if (parsed.port === '8787') return Promise.resolve(false);
  return new Promise((done) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        done(v);
      }
    };
    const req = httpRequest(
      { host: '127.0.0.1', port: Number(parsed.port), path: '/api/health', method: 'GET', agent: false },
      (res) => {
        res.resume();
        finish(res.statusCode === 200);
      },
    );
    req.on('error', () => finish(false));
    req.setTimeout(400, () => {
      req.destroy();
      finish(false);
    });
    req.end();
  });
}

/**
 * Inspect `.analyzer-session.json` in `installDir` without modifying anything.
 * Distinguishes:
 * - none: no lock file
 * - owned_by_self: created by this Companion process (launcherPid === process.pid)
 * - active_external: another live Analyzer/Companion process holds the lock (MUST NOT remove)
 * - stale: lock file exists, recorded PIDs are dead AND health URL is unreachable (safe to clean)
 */
export async function inspectSessionLock(installDir) {
  const target = resolve(String(installDir ?? ''));
  const lockPath = join(target, '.analyzer-session.json');
  let st;
  try {
    st = await lstat(lockPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { locked: false, kind: 'none', lockPath };
    return { locked: true, kind: 'active_external', lockPath, reason: err?.code ?? 'ACCESS_ERROR' };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { locked: true, kind: 'active_external', lockPath, reason: 'UNSAFE_LOCK' };
  }
  let meta = null;
  try {
    meta = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    meta = null;
  }
  const launcherPid = Number(meta?.launcherPid ?? 0);
  const servicePid = Number(meta?.servicePid ?? 0);
  const url = typeof meta?.url === 'string' ? meta.url : null;
  if (launcherPid === process.pid) {
    return { locked: true, kind: 'owned_by_self', launcherPid, servicePid, url, lockPath };
  }
  const launcherAlive = isPidAlive(launcherPid);
  const serviceAlive = isPidAlive(servicePid);
  if (launcherAlive || serviceAlive) {
    return { locked: true, kind: 'active_external', launcherPid, servicePid, url, lockPath };
  }
  if (url && (await probeLocalHealth(url))) {
    return { locked: true, kind: 'active_external', launcherPid, servicePid, url, lockPath };
  }
  return { locked: true, kind: 'stale', launcherPid, servicePid, url, lockPath };
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
export const BUNDLED_ANALYZER_REVISION = 3;
export const DEFAULT_R2_ZIP = join(REPO_ROOT, 'dist/distribution-EVZIMl/Bangumi-Analyzer-2.0.0-windows-x64-r3.zip');
export const R2_ZIP_HASH = 'adfeb5d29e59823c9d91def92eda18851a8b9991723435798842410ccf5f5ae6';

export function resolveCompanionHome(customHome) {
  if (customHome) return resolve(customHome);
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BangumiAnalyzerCompanion');
}

export function configPathFor(companionHome) {
  return join(companionHome, 'companion.json');
}

const DEFAULT_STATE = {
  firstRunCompleted: false,
  installDir: null,
  nickname: '',
  username: '',
  uid: null,
  collections: 0,
  aiConfigured: false,
  aiModel: '',
  skipIntro: false,
  autoStart: true,
  autoOpen: false,
  desktopShortcut: false,
  gpuMode: 'auto',
  live2dFpsMode: 'auto',
  installedAt: null,
  lastSyncAt: null,
};

export async function readCompanionState(companionHome) {
  try {
    const raw = JSON.parse(await readFile(configPathFor(companionHome), 'utf8'));
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function writeCompanionState(companionHome, patch) {
  await mkdir(companionHome, { recursive: true });
  const cur = await readCompanionState(companionHome);
  const next = { ...cur, ...patch };
  // Never store Bangumi Token or AI Key in companion.json; secrets live exclusively in Analyzer data/config.json.
  delete next.token;
  delete next.aiKey;
  await writeFile(configPathFor(companionHome), JSON.stringify(next, null, 2));
  return next;
}

async function freeSpaceGb(targetDir) {
  try {
    let probe = resolve(targetDir);
    while (true) {
      try {
        const s = await statfs(probe);
        return Number(((Number(s.bavail) * Number(s.bsize)) / (1024 ** 3)).toFixed(1));
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return null;
        probe = parent;
      }
    }
  } catch {
    return null;
  }
}

export async function validateInstallDir(rawPath, existingInstallDir = null) {
  const p = String(rawPath ?? '').trim();
  if (!p) return { level: 'error', title: '请选择一个文件夹', reasons: [], freeGb: null };
  if (p.startsWith('\\\\')) {
    return { level: 'error', title: '不支持网络路径', reasons: ['数据库需要本地磁盘，网络盘可能导致损坏'], freeGb: null };
  }
  if (!isAbsolute(p) || !/^[A-Za-z]:\\/.test(p)) {
    return { level: 'error', title: '路径格式无效', reasons: ['请填写完整的本地绝对路径，例如 D:\\Analyzer'], freeGb: null };
  }
  const resolved = resolve(p);
  const lower = resolved.toLowerCase();
  const errors = [];
  const warns = [];

  if (/\\program files( \(x86\))?(\\|$)/.test(lower)) errors.push('Program Files 需要管理员权限且受系统保护，不适合放置可写本地数据库');
  if (/\\windows(\\|$)/.test(lower)) errors.push('不能安装到 Windows 系统目录');
  if (/onedrive|dropbox|百度网盘|坚果云|icloud|google drive/.test(lower)) {
    errors.push('网盘同步目录会在运行中锁定或回滚 SQLite 数据库文件');
  }
  if (resolved.toLowerCase().startsWith(REPO_ROOT.toLowerCase()) && !resolved.toLowerCase().includes('.work')) {
    errors.push('不能安装到开发源代码仓库目录内（测试隔离目录除外）');
  }

  const freeGb = await freeSpaceGb(resolved);
  if (freeGb !== null && freeGb < 1) errors.push(`目标磁盘可用空间仅 ${freeGb} GB，至少需要 1 GB`);

  if (/^[a-z]:\\?$/.test(lower)) warns.push('不建议直接使用磁盘根目录，请新建专用子文件夹');
  if (/\\(desktop|桌面|downloads|下载)$/.test(lower)) warns.push('请勿直接安装到桌面或下载根目录，请在其中新建专用子文件夹');

  // 检查是否已存在且非空，同时核对会话锁归属，避免进入 Step 05 才撞上 SESSION_LOCKED
  try {
    const entries = await readdir(resolved);
    if (entries.length > 0) {
      const lock = await inspectSessionLock(resolved);
      if (lock.kind === 'active_external') {
        errors.push('该目录正被另一个运行中的 Analyzer 实例占用（会话锁有效）。请先关闭正在运行的窗口，或更换新的空白安装文件夹。');
      } else if (lock.kind === 'stale') {
        warns.push('检测到上次异常退出残留的失效会话锁（原进程已不存在），初始化时将自动安全清理并保留原有个人数据。');
      } else if (lock.kind === 'owned_by_self') {
        warns.push('该目录当前由本助手托管；继续初始化将先安全停止本助手的服务，并完整保留 data/ 中的个人数据。');
      } else if (!existingInstallDir || resolve(existingInstallDir).toLowerCase() !== lower) {
        warns.push(`目录内已有 ${entries.length} 个项目，建议使用全新空白文件夹（不会删除已有 data/ 个人数据）`);
      }
    }
  } catch { /* 目录尚未创建，正常 */ }

  if (errors.length) return { level: 'error', title: '这个位置不能使用', reasons: errors, freeGb };
  if (warns.length) return { level: 'warn', title: '可以使用，但建议调整', reasons: warns, freeGb };
  return { level: 'ok', title: '位置合适', reasons: ['本地可写磁盘 · 无需管理员权限 · 将建立独立数据目录'], freeGb };
}

export async function pickInstallDir(win) {
  const { dialog } = await import('electron');
  const res = await dialog.showOpenDialog(win, {
    title: '选择 Bangumi Analyzer 安装文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true, path: null };
  return { canceled: false, path: res.filePaths[0] };
}

async function probeLoopback() {
  return new Promise((resolveProbe) => {
    const srv = createServer();
    srv.once('error', (err) => resolveProbe({ ok: false, error: err.code ?? err.message }));
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolveProbe({ ok: true, port }));
    });
  });
}

export async function runRealEnvCheck(id, companionHome, targetDir, zipPath = DEFAULT_R2_ZIP) {
  switch (id) {
    case 'os': {
      const ok = process.platform === 'win32' && process.arch === 'x64';
      const memGb = Math.round(totalmem() / 1024 ** 3);
      return ok
        ? { state: 'ok', detail: `Windows ${release()} (x64) · 内存 ${memGb} GB（可用 ${Math.round(freemem() / 1024 ** 3)} GB）` }
        : { state: 'fail', detail: `不支持的平台 ${process.platform}/${process.arch}`, fix: '当前仅支持 Windows x64' };
    }
    case 'runtime': {
      try {
        const hash = await sha256(zipPath);
        return hash === R2_ZIP_HASH
          ? { state: 'ok', detail: `内置 Node 24.22.1 分发基线完整 (r${BUNDLED_ANALYZER_REVISION} SHA-256 已核验)` }
          : { state: 'fail', detail: '分发原包校验哈希不匹配', fix: `请重新获取完整的官方 r${BUNDLED_ANALYZER_REVISION} 发行包` };
      } catch {
        return { state: 'fail', detail: `未找到内置 Analyzer r${BUNDLED_ANALYZER_REVISION} 分发包`, fix: '请确认发行包随附资源完整' };
      }
    }
    case 'disk': {
      const freeGb = await freeSpaceGb(targetDir || companionHome);
      if (freeGb === null) return { state: 'warn', detail: '无法读取磁盘可用空间', fix: '请确保目标磁盘至少预留 1 GB 空间' };
      return freeGb >= 1
        ? { state: 'ok', detail: `目标磁盘可用 ${freeGb} GB（建议至少 1 GB）` }
        : { state: 'fail', detail: `可用空间仅 ${freeGb} GB，不足 1 GB`, fix: '清理磁盘或更换安装盘符' };
    }
    case 'write': {
      try {
        await mkdir(companionHome, { recursive: true });
        const probe = join(companionHome, `.write-probe-${Date.now()}`);
        await writeFile(probe, 'ok');
        await access(probe, fsConst.W_OK);
        await rm(probe, { force: true });
        return { state: 'ok', detail: '用户配置目录可读写 · 无需管理员权限' };
      } catch {
        return { state: 'fail', detail: '无法写入用户配置目录', fix: '检查磁盘只读属性或安全软件拦截' };
      }
    }
    case 'port': {
      const p = await probeLoopback();
      return p.ok
        ? { state: 'ok', detail: `127.0.0.1 回环监听可用（动态探测端口 ${p.port}）` }
        : { state: 'fail', detail: `本机回环端口不可用 (${p.error})`, fix: '检查本地防火墙或安全策略' };
    }
    case 'network': {
      try {
        const t0 = Date.now();
        const r = await fetch('https://api.bgm.tv/v0/subjects/1', {
          headers: { 'User-Agent': 'BangumiAnalyzerCompanion/2.0.0' },
          signal: AbortSignal.timeout(6000),
        });
        const ms = Date.now() - t0;
        return r.ok
          ? { state: 'ok', detail: `api.bgm.tv 连通正常 · ${ms} ms` }
          : { state: 'warn', detail: `api.bgm.tv 返回 HTTP ${r.status}`, fix: '可先完成本地安装，稍后再同步收藏' };
      } catch {
        return { state: 'warn', detail: '暂无法连接 api.bgm.tv', fix: '可先继续本地安装，联网后再绑定与同步' };
      }
    }
    default:
      return { state: 'fail', detail: '未知检测项' };
  }
}

export async function verifyRealBangumiAccount({ username, token }) {
  const user = String(username ?? '').trim();
  const tok = String(token ?? '').trim();
  if (!user) return { ok: false, code: 'EMPTY', message: '请填写 Bangumi 用户名或数字 UID' };
  const headers = { 'User-Agent': 'BangumiAnalyzerCompanion/2.0.0', Accept: 'application/json' };
  try {
    const uRes = await fetch(`https://api.bgm.tv/v0/users/${encodeURIComponent(user)}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (uRes.status === 404) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `找不到 Bangumi 用户「${user}」`,
        hint: '请填个人主页 URL 最后一段用户名或数字 UID，不要填邮箱或昵称。',
      };
    }
    if (!uRes.ok) {
      return { ok: false, code: 'API_ERROR', message: `Bangumi 接口返回 HTTP ${uRes.status}`, hint: '请稍后重试。' };
    }
    const uData = await uRes.json();

    if (tok) {
      const meRes = await fetch('https://api.bgm.tv/v0/me', {
        headers: { ...headers, Authorization: `Bearer ${tok}` },
        signal: AbortSignal.timeout(8000),
      });
      if (meRes.status === 401 || meRes.status === 403) {
        return {
          ok: false,
          code: 'TOKEN_INVALID',
          message: 'Access Token 无效或已过期',
          hint: '用户名有效。可重新生成个人令牌，或清空 Token 仅同步公开收藏。',
        };
      }
      if (meRes.ok) {
        const me = await meRes.json();
        if (me.id !== uData.id) {
          return {
            ok: false,
            code: 'TOKEN_INVALID',
            message: `该 Access Token 属于 @${me.username} (UID ${me.id})，与填写的 @${uData.username} 不匹配`,
            hint: '请使用同一账号的令牌，或清空 Token 仅同步公开收藏。',
          };
        }
      }
    }

    let collections = 0;
    try {
      const cHeaders = tok ? { ...headers, Authorization: `Bearer ${tok}` } : headers;
      const cRes = await fetch(`https://api.bgm.tv/v0/users/${encodeURIComponent(uData.username)}/collections?subject_type=2&limit=1`, {
        headers: cHeaders,
        signal: AbortSignal.timeout(8000),
      });
      if (cRes.ok) {
        const cData = await cRes.json();
        collections = Number(cData.total ?? 0);
      }
    } catch { /* non-fatal */ }

    return {
      ok: true,
      profile: {
        username: uData.username,
        uid: uData.id,
        nickname: uData.nickname || uData.username,
        sign: uData.sign || '',
        collections,
        privateVisible: Boolean(tok),
        hue: (Number(uData.id) * 47) % 360,
      },
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      code: 'TIMEOUT',
      message: isTimeout ? '连接 Bangumi 超时' : '无法连接到 Bangumi 服务器',
      hint: '请检查网络或代理；也可先点击「稍后再绑定」完成本地安装。',
    };
  }
}

export async function testRealAiConnection({ baseUrl, model, key }) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const mdl = String(model ?? '').trim();
  const apiKey = String(key ?? '').trim();
  if (!base || !mdl || !apiKey) return { ok: false, code: 'EMPTY', message: '请填写 Base URL、模型与 API Key' };
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'UNAUTHORIZED', message: `AI 服务返回 ${res.status} 鉴权失败`, hint: '请核对 API Key 是否有效或模型权限。' };
    }
    if (!res.ok) {
      return { ok: false, code: 'API_ERROR', message: `AI 服务返回 HTTP ${res.status}`, hint: '请核对 Base URL 与模型名称。' };
    }
    return { ok: true, latencyMs: Date.now() - t0, model: mdl };
  } catch {
    return { ok: false, code: 'TIMEOUT', message: '连接 AI 服务超时或地址不可达', hint: '请检查 Base URL 与网络连通性。' };
  }
}

async function copyProgramFilesPreservingData(srcDir, dstDir, isRoot = true) {
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isRoot && (entry.name.toLowerCase() === 'data' || entry.name === '.analyzer-session.json')) continue;
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyProgramFilesPreservingData(srcPath, dstPath, false);
    } else if (entry.isFile()) {
      await copyFile(srcPath, dstPath);
    }
  }
}

async function removeExtraProgramFilesPreservingData(rootDir, expectedFilesLowerSet, dir = rootDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (dir === rootDir && (entry.name.toLowerCase() === 'data' || entry.name === '.analyzer-session.json')) {
      continue;
    }
    const full = join(dir, entry.name);
    const rel = full.slice(rootDir.length + 1).replaceAll('\\', '/').toLowerCase();
    if (entry.isDirectory()) {
      await removeExtraProgramFilesPreservingData(rootDir, expectedFilesLowerSet, full);
      try {
        const rest = await readdir(full);
        if (rest.length === 0) await rm(full, { recursive: true, force: true });
      } catch { /* ignore */ }
    } else if (!expectedFilesLowerSet.has(rel)) {
      await rm(full, { force: true });
    }
  }
}

export async function extractVerifiedPackage(installDir, zipPath = DEFAULT_R2_ZIP) {
  const verdict = await validateInstallDir(installDir, installDir);
  if (verdict.level === 'error') {
    const isSessionLock = verdict.reasons.some((r) => r.includes('会话锁'));
    throw new SetupError(
      isSessionLock ? 'SESSION_LOCKED' : 'INVALID_INSTALL_DIR',
      verdict.reasons[0] || verdict.title,
      isSessionLock
        ? '请先关闭正在运行的 Analyzer/Companion 窗口后再重试，或点击「更换安装目录」选择新的空白文件夹。'
        : '请返回上一步重新选择合规的本地安装目录。',
    );
  }
  try {
    if ((await sha256(zipPath)) !== R2_ZIP_HASH) {
      throw new SetupError('ZIP_HASH_MISMATCH', '内置 Analyzer 分发包校验不匹配', '请重新下载完整的官方 Companion 安装包。');
    }
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError('PACKAGE_MISSING', '未找到内置 Analyzer 分发包', '请重新下载或重新安装 Companion。');
  }

  const target = resolve(installDir);
  try {
    await mkdir(target, { recursive: true });
    await normalPath(target);
  } catch (err) {
    const code = err?.code === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : 'PACKAGE_ACCESS';
    throw new SetupError(
      code,
      code === 'UNSAFE_PATH' ? '安装路径包含符号链接或指向受保护目录' : '无法创建或写入目标安装目录',
      '请返回上一步更换到普通本地文件夹（例如 D:\\BangumiAnalyzer），并检查磁盘权限。',
    );
  }

  // 严格区分活跃外部锁与残留失效锁
  const lock = await inspectSessionLock(target);
  if (lock.kind === 'active_external') {
    throw new SetupError(
      'SESSION_LOCKED',
      '该安装目录正被另一个运行中的 Analyzer 实例占用。',
      '不会强制结束外部进程。请先关闭正在运行的窗口后重试，或点击「更换安装目录」选择其他空白文件夹（不会影响原有数据）。',
    );
  }
  if (lock.kind === 'stale') {
    await unlink(lock.lockPath).catch(() => {});
  }

  // 幂等复用：如果已有完整校验通过的程序文件，直接复用并保留 data/
  let validExisting = false;
  try {
    await checkPackage(target);
    validExisting = true;
  } catch (err) {
    if (err?.code === 'SESSION_LOCKED') {
      throw new SetupError(
        'SESSION_LOCKED',
        '该安装目录正被另一个运行中的 Analyzer 实例占用。',
        '请先关闭正在运行的窗口后重试，或点击「更换安装目录」选择其他空白文件夹。',
      );
    }
  }

  if (!validExisting) {
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const psExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const existingEntries = await readdir(target).catch(() => []);
    const isEmpty = existingEntries.length === 0;
    if (isEmpty) {
      const r = spawnSync(
        psExe,
        ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zipPath)},${quote(target)})`],
        { windowsHide: true, encoding: 'utf8' },
      );
      if (r.status !== 0) {
        throw new SetupError(
          'ZIP_EXTRACT_FAILED',
          '解压 Analyzer 程序文件失败（目标目录可能无写入权限或文件被占用）',
          '请检查磁盘剩余空间和文件夹权限，或点击「更换安装目录」选择其他位置。',
        );
      }
    } else {
      // 仅对“已有 Analyzer 局部/完整安装痕迹”的目录执行程序修复；若目录内是用户的其他无关文件，绝不删除用户文件！
      const analyzerMarkers = new Set(['service.mjs', 'release.json', 'checksums.json', 'start-analyzer.bat', 'launch.mjs', 'runtime', 'packages', 'data']);
      const hasAnalyzerMarker = existingEntries.some((n) => analyzerMarkers.has(n.toLowerCase()));
      const hasUnrelatedFiles = !hasAnalyzerMarker;
      if (hasUnrelatedFiles) {
        throw new SetupError(
          'DIR_NOT_EMPTY',
          `目标文件夹内已有 ${existingEntries.length} 个非本软件的文件，为保护你的文件不会继续覆盖。`,
          '请点击「更换安装目录」，新建一个空白的专用子文件夹（例如 D:\\BangumiAnalyzer）再重试。',
        );
      }
      // 目标目录存在上次安装残留或旧版程序文件：先解包到同级临时目录，再增量覆盖程序文件，严格保护 data/
      const stageParent = dirname(target);
      const stageDir = await mkdtemp(join(stageParent, '.bangumi-stage-'));
      try {
        const r = spawnSync(
          psExe,
          ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zipPath)},${quote(stageDir)})`],
          { windowsHide: true, encoding: 'utf8' },
        );
        if (r.status !== 0) {
          throw new SetupError(
            'ZIP_EXTRACT_FAILED',
            '解压修复程序文件失败（磁盘空间不足或目录不可写）',
            '请清理空间或点击「更换安装目录」选择新的空白文件夹（原有 data/ 数据未被改动）。',
          );
        }
        const manifest = JSON.parse(await readFile(join(stageDir, 'checksums.json'), 'utf8'));
        const expectedSet = new Set(['checksums.json', ...manifest.files.map((f) => String(f.path).toLowerCase())]);
        await copyProgramFilesPreservingData(stageDir, target);
        await removeExtraProgramFilesPreservingData(target, expectedSet);
      } finally {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    try {
      await checkPackage(target);
    } catch (err) {
      const code = err?.code || 'PACKAGE_INVALID';
      if (code === 'SESSION_LOCKED') {
        throw new SetupError(
          'SESSION_LOCKED',
          '目录在校验期间被另一运行中的 Analyzer 实例锁定。',
          '请先关闭其他实例，或更换安装目录后重试。',
        );
      }
      throw new SetupError(
        code,
        `程序完整性校验未通过（${code}）`,
        '目标目录可能存在非本软件的额外文件或被杀毒软件拦截。建议点击「更换安装目录」选择全新空白文件夹重试。',
      );
    }
  }
  return target;
}

export function shortcutTargetSpec({ electronExe, mainScript, companionHome }) {
  const hostDir = dirname(mainScript);
  const rootDir = resolve(hostDir, '..');
  const launcherExe = join(rootDir, 'Bangumi-Analyzer-Companion.exe');
  const hasLauncher = existsSync(launcherExe);
  const isInstalled = hasLauncher && existsSync(join(rootDir, '.companion-installed'));
  const isPortable = hasLauncher && existsSync(join(rootDir, '.companion-portable')) && !isInstalled;

  if (isInstalled) {
    const defaultHome = resolveCompanionHome(null);
    const customArgs = companionHome && resolve(companionHome).toLowerCase() !== resolve(defaultHome).toLowerCase()
      ? `--companionHome "${companionHome}"`
      : '';
    return {
      shortcutName: 'Bangumi Analyzer Companion.lnk',
      targetPath: launcherExe,
      argumentsStr: customArgs,
      workingDir: rootDir,
      iconLocation: `${launcherExe},0`,
    };
  }
  if (isPortable) {
    const portableDefaultHome = join(rootDir, 'companion-data');
    const customArgs = companionHome && resolve(companionHome).toLowerCase() !== resolve(portableDefaultHome).toLowerCase()
      ? `--companionHome "${companionHome}"`
      : '';
    return {
      shortcutName: 'Bangumi Analyzer Companion (Portable).lnk',
      targetPath: launcherExe,
      argumentsStr: customArgs,
      workingDir: rootDir,
      iconLocation: `${launcherExe},0`,
    };
  }
  const devIcon = join(hostDir, 'assets', 'companion-icon.ico');
  return {
    shortcutName: 'Bangumi Analyzer Companion.lnk',
    targetPath: electronExe,
    argumentsStr: `"${mainScript}" --companionHome "${companionHome}"`,
    workingDir: hostDir,
    iconLocation: existsSync(devIcon) ? `${devIcon},0` : `${electronExe},0`,
  };
}

export function createDesktopShortcut({ electronExe, mainScript, companionHome }) {
  try {
    const psExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const spec = shortcutTargetSpec({ electronExe, mainScript, companionHome });
    const script = [
      '$ws = New-Object -ComObject WScript.Shell',
      '$desk = [Environment]::GetFolderPath("Desktop")',
      `$lnk = $ws.CreateShortcut((Join-Path $desk ${quote(spec.shortcutName)}))`,
      `$lnk.TargetPath = ${quote(spec.targetPath)}`,
      `$lnk.Arguments = ${quote(spec.argumentsStr)}`,
      `$lnk.WorkingDirectory = ${quote(spec.workingDir)}`,
      `$lnk.IconLocation = ${quote(spec.iconLocation)}`,
      '$lnk.Description = "Bangumi Analyzer Companion · 小番桌面助手"',
      '$lnk.Save()',
      'Add-Type -MemberDefinition "[DllImport(\\"shell32.dll\\")] public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);" -Name ShellNotify -Namespace Win32 -ErrorAction SilentlyContinue | Out-Null',
      '[Win32.ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)',
    ].join('; ');
    const r = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function removeDesktopShortcut({ mainScript } = {}) {
  try {
    const psExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const rootDir = mainScript ? resolve(dirname(mainScript), '..') : null;
    const isPortable = rootDir && existsSync(join(rootDir, '.companion-portable')) && !existsSync(join(rootDir, '.companion-installed'));
    const lnkName = isPortable ? 'Bangumi Analyzer Companion (Portable).lnk' : 'Bangumi Analyzer Companion.lnk';
    const script = `$p = Join-Path ([Environment]::GetFolderPath("Desktop")) '${lnkName}'; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }`;
    spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  } catch { /* ignore */ }
}

/** 仅供测试/辅助创建一个受临时目录隔离的空白目录 */
export async function createIsolatedTempWork(prefix = 'm2-test') {
  const w = join(here, '.work');
  await mkdir(w, { recursive: true });
  return mkdtemp(join(w, `${prefix}-`));
}
