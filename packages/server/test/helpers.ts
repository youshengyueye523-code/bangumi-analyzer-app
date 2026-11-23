import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import type {
  BgmCollectionItem,
  BgmMe,
  BgmPersonRelation,
  BgmSubject,
  BgmSubjectRelation,
} from '@bangumi-analyzer/shared';
import type {
  BangumiDataSource,
  BangumiClientStats,
  RequestOptions,
} from '../src/bangumi/client.js';
import { BangumiApiError } from '../src/bangumi/client.js';
import type { AppConfig } from '../src/config.js';
import { paths, PROJECT_ROOT } from '../src/config.js';
import { getDatabase } from '../src/db/index.js';
import { SyncEngine } from '../src/sync/engine.js';

export const TEST_TABLES = [
  'franchise_member_assignments',
  'subject_user_hides',
  'franchise_member_exclusions',
  'franchise_series',
  'franchise_entities',
  'series_entity_members',
  'series_entities',
  'entity_aliases',
  'entity_events',
  'candidate_decisions',
  'series_legacy_snapshot',
  'collection_rating_history',
  'collections',
  'subject_staff',
  'subject_relations',
  'profile_reports',
  'profile_snapshots',
  'translation_jobs',
  'series_members',
  'series',
  'sync_stage',
  'subjects',
  'sync_runs',
  'meta',
] as const;

/**
 * 测试隔离保护（v1.7.0 RC）。
 *
 * 事故背景：从仓库根目录直接执行 `vitest run packages/server/test/...` 时，
 * 不会加载 packages/server/vitest.config.ts，setup 也就不会运行，
 * 测试因此会落到真实 data 目录——`resetDatabase()` 曾因此清空真实数据库。
 *
 * 规则：破坏性测试辅助只允许在「真实 Local 目录之外」执行：
 * - 永远拒绝仓库内的真实 data 目录（即使显式配置指向它）；
 * - 其余情况要求数据目录来自显式配置（BANGUMI_DATA_DIR）或位于系统临时目录。
 * 违反时立刻抛错，绝不触碰任何数据。
 */
export function assertIsolatedTestDatabase(): void {
  const dataDir = resolve(paths.dataDir);
  const realDataDir = resolve(PROJECT_ROOT, 'data');
  if (dataDir === realDataDir) {
    throw new Error(
      `[test-isolation] 拒绝在真实 Local 数据目录上执行破坏性测试操作：${dataDir}。` +
        '请通过包内配置运行测试（例如 pnpm -C packages/server run test）。',
    );
  }
  const tempRoot = resolve(tmpdir());
  const insideTemp = dataDir === tempRoot || dataDir.startsWith(`${tempRoot}${sep}`);
  const configuredDir = (process.env.BANGUMI_DATA_DIR ?? '').trim();
  if (insideTemp || configuredDir) return;
  throw new Error(
    `[test-isolation] 测试数据目录既不在系统临时目录，也没有显式配置：${dataDir}。` +
      '为避免误伤真实数据，已拒绝执行破坏性测试操作。',
  );
}

/** 清空所有业务表（保留表结构），用于测试之间隔离。 */
export function resetDatabase(): void {
  assertIsolatedTestDatabase();
  const db = getDatabase();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of TEST_TABLES) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

export function testConfig(patch: Partial<AppConfig> = {}): AppConfig {
  return {
    username: 'tester',
    token: '',
    nickname: '',
    avatar: '',
    onboardingSeen: true,
    summaryAutoTranslate: true,
    summaryConcurrency: 2,
    subjectTypes: [2],
    requestIntervalMs: 0,
    detailRefreshDays: 30,
    userAgent: 'bangumi-analyzer-test/1.0.0',
    cacheCovers: false,
    httpProxy: '',
    ...patch,
  };
}

export function makeCollectionItem(
  overrides: Partial<BgmCollectionItem> & { subject_id: number },
): BgmCollectionItem {
  const id = overrides.subject_id;
  return {
    subject_id: id,
    subject_type: 2,
    rate: 7,
    type: 2,
    comment: '',
    tags: [],
    ep_status: 12,
    vol_status: 0,
    updated_at: '2024-05-01T10:00:00+08:00',
    private: false,
    subject: {
      id,
      type: 2,
      name: `Test Anime ${id}`,
      name_cn: `测试动画 ${id}`,
      short_summary: '简介',
      date: '2015-04-01',
      images: {
        large: `https://lain.bgm.tv/pic/cover/l/${id}.jpg`,
        common: `https://lain.bgm.tv/pic/cover/c/${id}.jpg`,
        medium: '',
        small: '',
        grid: '',
      },
      volumes: 0,
      eps: 12,
      collection_total: 1000,
      score: 7.5,
      rank: 500,
      tags: [
        { name: 'TV', count: 100, total_count: 1000 },
        { name: '科幻', count: 50, total_count: 5000 },
      ],
    },
    ...overrides,
  };
}

export function makeSubject(overrides: Partial<BgmSubject> & { id: number }): BgmSubject {
  const id = overrides.id;
  return {
    id,
    type: 2,
    name: `Test Anime ${id}`,
    name_cn: `测试动画 ${id}`,
    summary: '完整简介',
    series: false,
    nsfw: false,
    locked: false,
    date: '2015-04-01',
    platform: 'TV',
    images: { large: `https://lain.bgm.tv/pic/cover/l/${id}.jpg`, common: '', medium: '', small: '', grid: '' },
    infobox: [
      { key: '中文名', value: `测试动画 ${id}` },
      { key: '别名', value: [{ v: `Test Anime ${id}` }, { k: '英文名', v: `Test Anime English ${id}` }] },
      { key: '动画制作', value: '京都动画' },
      { key: '导演', value: '石原立也' },
      { key: '原作', value: '轻小说' },
    ],
    volumes: 0,
    eps: 12,
    total_episodes: 12,
    rating: {
      rank: 500,
      total: 3000,
      score: 7.5,
      count: { '1': 1, '2': 2, '3': 5, '4': 10, '5': 50, '6': 300, '7': 900, '8': 800, '9': 300, '10': 100 },
    },
    collection: { wish: 100, collect: 800, doing: 50, on_hold: 20, dropped: 10 },
    meta_tags: ['TV', '日本'],
    tags: [
      { name: 'TV', count: 100, total_count: 1000 },
      { name: '科幻', count: 50, total_count: 5000 },
      { name: '日常', count: 30, total_count: 3000 },
    ],
    ...overrides,
  };
}

export interface FakeClientOptions {
  collections?: BgmCollectionItem[];
  subjects?: Record<number, BgmSubject>;
  relations?: Record<number, BgmSubjectRelation[]>;
  persons?: Record<number, BgmPersonRelation[]>;
  me?: BgmMe;
  users?: Record<string, BgmMe>;
  /** 指定 offset 的分页请求抛出错误，用于测试部分失败 */
  pageErrors?: Record<number, unknown>;
  /** 指定条目详情请求抛出错误 */
  subjectErrors?: Record<number, unknown>;
  onRequest?: (path: string, params: Record<string, unknown>) => void;
  /** 每个请求的额外延迟（毫秒），用于测试取消 */
  delayMs?: number;
}

/**
 * 可控的 Bangumi 数据源实现。
 * 测试通过它精确复现分页、失败、空数据、字段缺失等边界情况。
 */
export class FakeBangumiClient implements BangumiDataSource {
  readonly stats: BangumiClientStats = {
    requests: 0,
    retries: 0,
    throttled: 0,
    lastRequestMs: 0,
  };

  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly options: FakeClientOptions;

  constructor(options: FakeClientOptions = {}) {
    this.options = options;
  }

  updateOptions(): void {
    // 假实现无需更新任何配置
  }

  private async tick(method: string, ...args: unknown[]): Promise<void> {
    this.stats.requests += 1;
    this.calls.push({ method, args });
    if (this.options.onRequest) this.options.onRequest(method, { args });
    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
  }

  async getMe(_options?: RequestOptions): Promise<BgmMe> {
    await this.tick('getMe');
    return (
      this.options.me ?? {
        id: 1,
        username: 'tester',
        nickname: '测试用户',
        sign: '',
        avatar: {},
      }
    );
  }

  async getUser(username: string, _options?: RequestOptions): Promise<BgmMe> {
    await this.tick('getUser', username);
    const user = this.options.users?.[username] ?? { id: 1, username: 'tester', nickname: '', sign: '', avatar: {} };
    if (username !== String(user.id) && username.toLowerCase() !== user.username.toLowerCase()) {
      throw new BangumiApiError('not_found', '账号不存在', { status: 404 });
    }
    return user;
  }

  async getCollectionsPage(
    _username: string,
    params: { subjectType?: number; collectionType?: number; limit: number; offset: number },
    _options?: RequestOptions,
  ): Promise<{ total: number; limit: number; offset: number; data: unknown[] }> {
    await this.tick('getCollectionsPage', params);
    const error = this.options.pageErrors?.[params.offset];
    if (error) throw error;
    const all = this.options.collections ?? [];
    /*
     * 与真实 API 一致：subject_type 过滤只返回该类型的收藏（v1.8.3 B1 测试需要）。
     * 结构异常、没有 subject_type 的条目照常返回 —— 它们仍要走「解析失败并跳过」的路径。
     */
    const scoped =
      params.subjectType === undefined
        ? all
        : all.filter((item) => {
            const type = (item as { subject_type?: unknown }).subject_type;
            return typeof type !== 'number' || type === params.subjectType;
          });
    return {
      total: scoped.length,
      limit: params.limit,
      offset: params.offset,
      data: scoped.slice(params.offset, params.offset + params.limit),
    };
  }

  async getSubject(subjectId: number, _options?: RequestOptions): Promise<BgmSubject> {
    await this.tick('getSubject', subjectId);
    const error = this.options.subjectErrors?.[subjectId];
    if (error) throw error;
    const subject = this.options.subjects?.[subjectId];
    if (!subject) throw new BangumiApiError('not_found', `条目 ${subjectId} 不存在`);
    return subject;
  }

  async getSubjectRelations(
    subjectId: number,
    _options?: RequestOptions,
  ): Promise<BgmSubjectRelation[]> {
    await this.tick('getSubjectRelations', subjectId);
    return this.options.relations?.[subjectId] ?? [];
  }

  async getSubjectPersons(
    subjectId: number,
    _options?: RequestOptions,
  ): Promise<BgmPersonRelation[]> {
    await this.tick('getSubjectPersons', subjectId);
    return this.options.persons?.[subjectId] ?? [];
  }

  async fetchImage(
    _url: string,
    _options?: RequestOptions,
  ): Promise<{ data: Uint8Array; contentType: string | null }> {
    await this.tick('fetchImage', _url);
    return { data: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' };
  }
}

export interface RunSyncOptions {
  mode?: 'full' | 'incremental' | 'enrich';
  depth?: 1 | 2;
  forceDetail?: boolean;
  limits?: { details?: number; relations?: number; persons?: number };
  config?: Partial<AppConfig>;
}

/** 运行一次完整同步并等待结束，返回同步状态。 */
export async function runSync(
  client: FakeBangumiClient,
  options: RunSyncOptions = {},
): Promise<ReturnType<SyncEngine['getStatus']>> {
  const engine = new SyncEngine({
    client,
    getConfig: () => testConfig(options.config),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  engine.start({
    mode: options.mode ?? 'incremental',
    depth: options.depth ?? 1,
    ...(options.forceDetail !== undefined ? { forceDetail: options.forceDetail } : {}),
  });
  await engine.whenIdle();
  return engine.getStatus();
}
