/**
 * 首次设置流程的模拟服务（非 Codex 契约，仅原型使用）。
 * 不读取磁盘、不访问网络、不写入任何文件。所有结果都由 scenario 决定。
 */
import { scenario, wait, jitter } from './scenario';

/* ───────────── 环境检查 ───────────── */

export type CheckState = 'pending' | 'running' | 'ok' | 'warn' | 'fail';

export interface EnvCheck {
  id: 'os' | 'runtime' | 'disk' | 'write' | 'port' | 'network';
  label: string;
  state: CheckState;
  detail: string;
  /** 失败 / 警告时的修复建议 */
  fix?: string;
  /** warn 允许继续，fail 阻断 */
}

export const ENV_ITEMS: Pick<EnvCheck, 'id' | 'label'>[] = [
  { id: 'os', label: '操作系统' },
  { id: 'runtime', label: '内置运行时' },
  { id: 'disk', label: '磁盘空间' },
  { id: 'write', label: '目录写入权限' },
  { id: 'port', label: '本机端口' },
  { id: 'network', label: 'Bangumi 连通性' },
];

export async function runEnvCheck(
  id: EnvCheck['id'],
  signal?: AbortSignal,
): Promise<Pick<EnvCheck, 'state' | 'detail' | 'fix'>> {
  const s = scenario.get();
  await wait(jitter(id === 'network' ? 1100 : 520), signal);
  switch (id) {
    case 'os':
      return { state: 'ok', detail: 'Windows 11 64 位 · 23H2' };
    case 'runtime':
      return { state: 'ok', detail: 'Node 24 运行时随程序附带，无需安装' };
    case 'disk':
      return scenario.shouldFail('env.disk', s.env === 'low-disk')
        ? { state: 'fail', detail: '目标磁盘可用 0.4 GB，至少需要 1 GB', fix: '清理磁盘，或在下一步选择其他磁盘' }
        : { state: 'ok', detail: 'D: 可用 412 GB（建议至少 1 GB）' };
    case 'write':
      return scenario.shouldFail('env.write', s.env === 'no-write')
        ? { state: 'fail', detail: '无法在用户目录创建测试文件', fix: '检查安全软件拦截，或以普通用户身份重新打开 Companion' }
        : { state: 'ok', detail: '用户目录可写 · 无需管理员权限' };
    case 'port':
      return scenario.shouldFail('env.port', s.env === 'port-busy')
        ? {
            state: 'fail',
            detail: '默认端口 5173 已被占用（模拟：某开发服务器）',
            fix: '关闭占用程序后重新检测；Companion 不会结束其他进程',
          }
        : { state: 'ok', detail: '127.0.0.1:5173 可用 · 仅本机访问' };
    case 'network':
      return scenario.shouldFail('env.network', s.env === 'offline')
        ? {
            state: 'warn',
            detail: '无法连接 api.bgm.tv（超时 8s）',
            fix: '可以先继续安装，联网后再同步收藏',
          }
        : { state: 'ok', detail: 'api.bgm.tv 响应 186 ms' };
  }
}

/* ───────────── 安装目录 ───────────── */

export type DirLevel = 'ok' | 'warn' | 'error';
export interface DirVerdict {
  level: DirLevel;
  title: string;
  reasons: string[];
  freeGb: number | null;
}

const DRIVE_FREE: Record<string, number> = { C: 38.2, D: 412.6, E: 96.0 };

/** 规则来自 docs/distribution/USER_README.md 的目录要求 */
export function validateInstallDir(raw: string): DirVerdict {
  const p = raw.trim();
  if (!p) return { level: 'error', title: '请选择一个文件夹', reasons: [], freeGb: null };
  const drive = /^([A-Za-z]):\\/.exec(p)?.[1]?.toUpperCase();
  if (p.startsWith('\\\\')) {
    return { level: 'error', title: '不支持网络路径', reasons: ['数据库需要本地磁盘，网络盘可能导致损坏'], freeGb: null };
  }
  if (!drive) return { level: 'error', title: '路径格式无效', reasons: ['示例：D:\\Analyzer'], freeGb: null };
  const free = DRIVE_FREE[drive] ?? 120;
  const lower = p.toLowerCase();
  const errors: string[] = [];
  const warns: string[] = [];
  if (/program files/.test(lower)) errors.push('Program Files 需要管理员权限，且会被系统保护');
  if (/onedrive|dropbox|百度网盘|坚果云|icloud|google drive/.test(lower))
    errors.push('网盘同步目录会在运行中锁定或回滚数据库文件');
  if (/\\windows(\\|$)/.test(lower)) errors.push('不能安装到系统目录');
  if (/^[a-z]:\\?$/.test(lower)) warns.push('建议不要直接使用磁盘根目录，请新建专用子文件夹');
  if (/\\(desktop|桌面|downloads|下载)\\?$/.test(lower))
    warns.push('桌面 / 下载文件夹已有其他文件，请在其中新建专用子文件夹');
  if (/旧|old|backup/.test(lower)) warns.push('该文件夹看起来已有内容（模拟），请确认它是全新的空文件夹');
  if (free < 1) errors.push('可用空间不足 1 GB');
  if (errors.length) return { level: 'error', title: '这个位置不能使用', reasons: errors, freeGb: free };
  if (warns.length) return { level: 'warn', title: '可以使用，但建议调整', reasons: warns, freeGb: free };
  return { level: 'ok', title: '位置合适', reasons: ['本地磁盘 · 无需管理员权限 · 将创建全新数据目录'], freeGb: free };
}

export const DIR_SUGGESTIONS = [
  { path: 'D:\\Analyzer', note: '推荐 · 数据盘' },
  { path: 'C:\\Users\\ASUS\\Bangumi Analyzer', note: '用户目录' },
  { path: 'C:\\Program Files\\Bangumi Analyzer', note: '演示：会被拒绝' },
  { path: 'C:\\Users\\ASUS\\OneDrive\\Analyzer', note: '演示：网盘目录' },
  { path: 'C:\\Users\\ASUS\\Desktop', note: '演示：需要子文件夹' },
];

/* ───────────── Bangumi 账号 ───────────── */

export interface BangumiProfile {
  username: string;
  uid: number;
  nickname: string;
  sign: string;
  collections: number;
  privateVisible: boolean;
  hue: number;
}

export class MockError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

export async function verifyBangumiAccount(username: string, token: string, signal?: AbortSignal) {
  const s = scenario.get();
  await wait(jitter(1500), signal);
  if (scenario.shouldFail('account', s.account === 'timeout'))
    throw new MockError('TIMEOUT', '连接 Bangumi 超时', '网络可能不稳定。可以重试，或先跳过稍后在 Analyzer 设置中绑定。');
  if (scenario.shouldFail('account', s.account === 'not-found'))
    throw new MockError('NOT_FOUND', `找不到用户「${username}」`, '用户名是个人主页地址最后一段，不是邮箱或昵称；也可以填写数字 UID。');
  if (token && scenario.shouldFail('account', s.account === 'token-invalid'))
    throw new MockError('TOKEN_INVALID', 'Access Token 无效或已过期', '用户名已验证。可以重新生成令牌，或清空 Token 只同步公开收藏。');
  const uid = /^\d+$/.test(username) ? Number(username) : 400000 + (hash(username) % 600000);
  const profile: BangumiProfile = {
    username,
    uid,
    nickname: /^\d+$/.test(username) ? `用户 ${username}` : username.charAt(0).toUpperCase() + username.slice(1),
    sign: '今天也要好好补番。',
    collections: 640 + (hash(username) % 900),
    privateVisible: Boolean(token),
    hue: hash(username) % 360,
  };
  return profile;
}

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.abs(h);
}

/* ───────────── AI 配置 ───────────── */

export interface AiConfig {
  provider: 'openai' | 'deepseek' | 'gemini' | 'custom';
  baseUrl: string;
  model: string;
  key: string;
}

export const AI_PROVIDERS: { id: AiConfig['provider']; name: string; baseUrl: string; model: string; note: string }[] = [
  { id: 'openai', name: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', note: '通用 Chat Completions 接口' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', note: '中文表现好 · 价格低' },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', note: 'OpenAI 兼容端点' },
  { id: 'custom', name: '自定义', baseUrl: '', model: '', note: '本地模型 / 代理网关' },
];

export async function testAiConnection(cfg: AiConfig, signal?: AbortSignal) {
  const s = scenario.get();
  await wait(jitter(1300), signal);
  if (scenario.shouldFail('ai', s.ai === 'unauthorized'))
    throw new MockError('UNAUTHORIZED', '服务返回 401 Unauthorized', 'API Key 不正确或没有该模型的权限。');
  if (scenario.shouldFail('ai', s.ai === 'timeout'))
    throw new MockError('TIMEOUT', '请求超时（15s）', '检查 Base URL 是否正确、网络或代理是否可用。');
  return { latencyMs: 420 + Math.round(Math.random() * 300), model: cfg.model };
}

/* ───────────── 初始化与同步 ───────────── */

export type StageId = 'prepare' | 'integrity' | 'database' | 'service' | 'sync' | 'details' | 'snapshot';
export interface StageDef {
  id: StageId;
  label: string;
  desc: string;
  needsAccount?: boolean;
  weight: number;
}

export const STAGES: StageDef[] = [
  { id: 'prepare', label: '准备程序目录', desc: '创建 data / backups / logs 目录', weight: 6 },
  { id: 'integrity', label: '校验文件完整性', desc: '比对 checksums.json', weight: 8 },
  { id: 'database', label: '初始化本地数据库', desc: '创建 SQLite 结构与索引', weight: 8 },
  { id: 'service', label: '启动 Analyzer 服务', desc: '仅监听 127.0.0.1', weight: 8 },
  { id: 'sync', label: '同步 Bangumi 收藏', desc: '分页拉取全部收藏', needsAccount: true, weight: 40 },
  { id: 'details', label: '补全条目详情', desc: '标签、制作人员与关联作品', needsAccount: true, weight: 24 },
  { id: 'snapshot', label: '生成首份统计', desc: '仪表盘与画像证据', weight: 6 },
];

export const SAMPLE_TITLES = [
  '葬送的芙莉莲', '孤独摇滚！', '赛博朋克：边缘行者', '星际牛仔', '凉宫春日的忧郁', '命运石之门',
  '紫罗兰永恒花园', '轻音少女', '少女歌剧', '利兹与青鸟', '摇曳露营△', '魔法少女小圆',
  '冰菓', '响け！上低音号', '强风吹拂', 'Vivy -Fluorite Eye\'s Song-', '莉可丽丝', '明日方舟：黎明前奏',
  '天元突破 红莲螺岩', '电脑线圈', '来自深渊', '虫师', '四月是你的谎言', '吹响吧！上低音号',
];

export interface StageFailure {
  code: string;
  message: string;
  hint: string;
}

/** 某阶段这一次是否失败，以及在进度的哪个位置失败 */
export function plannedFailure(id: StageId): { at: number; err: StageFailure } | null {
  const s = scenario.get();
  if (id === 'database' && scenario.shouldFail('init.db', s.sync === 'db-locked'))
    return {
      at: 0.6,
      err: {
        code: 'DATA_LOCKED',
        message: '数据库文件被占用（模拟：另一个 Analyzer 实例）',
        hint: '关闭其他正在运行的 Analyzer 后重试。不会删除或覆盖任何数据。',
      },
    };
  if (id === 'sync' && scenario.shouldFail('init.sync', s.sync === 'rate-limit'))
    return {
      at: 0.46,
      err: {
        code: 'RATE_LIMITED',
        message: 'Bangumi 返回 429 Too Many Requests',
        hint: '已保存断点（第 14 页）。稍等片刻后从断点继续，已拉取的数据不会丢失。',
      },
    };
  if (id === 'details' && scenario.shouldFail('init.details', s.sync === 'network-drop'))
    return {
      at: 0.3,
      err: {
        code: 'NETWORK',
        message: '网络连接中断',
        hint: '恢复网络后从断点继续。也可以先进入 Analyzer，详情会在下次同步时补全。',
      },
    };
  return null;
}
