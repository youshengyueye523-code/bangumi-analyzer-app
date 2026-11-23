import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function canonicalPath(path: string): string {
  const resolved = realpathSync(resolve(path));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** 在启动服务之前验证：E2E 只允许显式创建的临时夹具目录。 */
export function isolatedDataDir(value: string | undefined, projectRoot: string): string {
  if (!value?.trim()) {
    throw new Error('[e2e-isolation] 必须显式设置 E2E_DATA_DIR 为独立临时夹具目录；拒绝使用真实 Local。');
  }
  const directory = canonicalPath(value);
  const productionPath = resolve(projectRoot, 'data');
  const production = existsSync(productionPath) ? canonicalPath(productionPath) : resolve(canonicalPath(projectRoot), 'data');
  const temporary = canonicalPath(tmpdir());
  if (contains(production, directory) || contains(directory, production)) {
    throw new Error('[e2e-isolation] 拒绝使用真实 data、其子目录或祖先目录。');
  }
  if (directory === temporary || !contains(temporary, directory)) {
    throw new Error('[e2e-isolation] E2E_DATA_DIR 必须是系统临时目录中的独立子目录。');
  }
  if (!lstatSync(directory).isDirectory()) throw new Error('[e2e-isolation] 夹具路径必须是目录。');
  assertNoLinkedAssets(directory);
  // realpath 拒绝通过 junction / symlink 将临时路径重定向到生产数据。
  return directory;
}

function assertNoLinkedAssets(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
      throw new Error('[e2e-isolation] 夹具不得包含 junction、symlink 或 hardlink；请使用独立副本。');
    }
    if (info.isDirectory()) assertNoLinkedAssets(path);
  }
}

/** health 仅含运行目标/计数，不读取 config 或任何凭据。 */
export function assertIsolatedServer(
  health: { ok?: boolean; dataDir?: string; dbPath?: string; syncRunning?: boolean },
  expectedDirectory: string,
  projectRoot: string,
): void {
  if (!health.ok || health.syncRunning || !health.dataDir || !health.dbPath) {
    throw new Error('[e2e-isolation] 目标服务未就绪或正在同步，拒绝运行测试。');
  }
  const actual = isolatedDataDir(health.dataDir, projectRoot);
  if (actual !== canonicalPath(expectedDirectory) || canonicalPath(health.dbPath) !== canonicalPath(resolve(actual, 'bangumi.db'))) {
    throw new Error('[e2e-isolation] 目标服务的实际 dataDir / dbPath 与隔离夹具不一致。');
  }
}
