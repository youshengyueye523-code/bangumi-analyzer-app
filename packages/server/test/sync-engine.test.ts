import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BangumiApiError } from '../src/bangumi/client.js';
import { all, one, run, getMeta, dataVersion } from '../src/db/index.js';
import { SyncEngine } from '../src/sync/engine.js';
import {
  FakeBangumiClient,
  makeCollectionItem,
  makeSubject,
  resetDatabase,
  runSync,
  testConfig,
} from './helpers.js';

function countCollections(): number {
  return Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM collections')?.n ?? 0);
}

function collectionOf(subjectId: number): { type: number; rate: number } | undefined {
  return one<{ type: number; rate: number }>(
    'SELECT type, rate FROM collections WHERE subject_id = :id',
    { id: subjectId },
  );
}

function seedCollection(ids: number[]): FakeBangumiClient {
  return new FakeBangumiClient({
    collections: ids.map((id) => makeCollectionItem({ subject_id: id })),
    subjects: Object.fromEntries(ids.map((id) => [id, makeSubject({ id })])),
  });
}

describe('同步引擎', () => {
  beforeEach(() => {
    resetDatabase();
  });

  /*
   * v1.8.3（B1）：删除只能作用于本次实际抓取的 subject type。
   * 事故背景：同步范围临时不含 type 4 时，10 条游戏收藏被当作「已删除」清掉，
   * 随后又被抓回，引发一整轮实体身份 churn。
   */
  it('B1：未抓取的 subject type 不参与删除，并产生保护 warning', async () => {
    const gameItem = (id: number) => {
      const item = makeCollectionItem({ subject_id: id, subject_type: 4 });
      return { ...item, subject: { ...item.subject, type: 4 } };
    };
    const first = new FakeBangumiClient({
      collections: [
        makeCollectionItem({ subject_id: 1 }),
        makeCollectionItem({ subject_id: 2 }),
        gameItem(101),
        gameItem(102),
      ],
      subjects: { 1: makeSubject({ id: 1 }), 2: makeSubject({ id: 2 }) },
    });
    await runSync(first, { config: { subjectTypes: [2, 4] } });
    expect(countCollections()).toBe(4);

    // 范围临时缩到动画：远端只返回 type 2，游戏收藏必须原样保留
    const narrowed = new FakeBangumiClient({
      collections: [makeCollectionItem({ subject_id: 1 }), makeCollectionItem({ subject_id: 2 })],
      subjects: { 1: makeSubject({ id: 1 }), 2: makeSubject({ id: 2 }) },
    });
    const status = await runSync(narrowed, { config: { subjectTypes: [2] } });

    expect(status.lastRun?.status).toBe('success');
    expect(status.lastRun?.counters.removed).toBe(0);
    expect(countCollections()).toBe(4);
    expect(status.lastRun?.warnings.join(' ')).toContain('不在删除范围内');
    expect(status.lastRun?.warnings.join(' ')).toContain('4');
  });

  it('B1：范围内真实消失的收藏仍然会被删除', async () => {
    const first = new FakeBangumiClient({
      collections: [makeCollectionItem({ subject_id: 1 }), makeCollectionItem({ subject_id: 2 })],
      subjects: { 1: makeSubject({ id: 1 }), 2: makeSubject({ id: 2 }) },
    });
    await runSync(first);
    expect(countCollections()).toBe(2);

    const second = new FakeBangumiClient({
      collections: [makeCollectionItem({ subject_id: 2 })],
      subjects: { 2: makeSubject({ id: 2 }) },
    });
    const status = await runSync(second);

    expect(status.lastRun?.counters.removed).toBe(1);
    expect(countCollections()).toBe(1);
    expect(collectionOf(2)).toBeTruthy();
  });

  it.each([false, true])('公开抓取不能证明私有收藏消失；authenticated=%s', async (authenticated) => {
    const initial = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 }), makeCollectionItem({ subject_id: 2, private: true })] });
    await runSync(initial);
    const preserved = collectionOf(2);
    const status = await runSync(seedCollection([1]), { config: { token: authenticated ? 'fixture-only-token' : '' } });
    expect(collectionOf(2)).toEqual(authenticated ? undefined : preserved);
    expect(status.lastRun?.counters.removed).toBe(authenticated ? 1 : 0);
    if (!authenticated) expect(status.lastRun?.warnings.join(' ')).toContain('私有收藏');
  });

  it('其他账号的有效 Token 不能证明目标账号的私有收藏已取消', async () => {
    await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 }), makeCollectionItem({ subject_id: 2, private: true })] }));
    const previous = collectionOf(2);
    const client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })],
      me: { id: 999, username: 'other-account', nickname: '', sign: '', avatar: {} },
    });
    const status = await runSync(client, { config: { token: 'fixture-only-token', username: 'tester' } });
    expect(collectionOf(2)).toEqual(previous);
    expect(status.lastRun?.counters.removed).toBe(0);
    expect(status.lastRun?.warnings.join(' ')).toContain('私有收藏');
  });

  it('目标填写 Token 账号数字 UID 时仍能合法确认私有收藏删除', async () => {
    await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 }), makeCollectionItem({ subject_id: 2, private: true })] }));
    const status = await runSync(seedCollection([1]), { config: { token: 'fixture-only-token', username: '1' } });
    expect(status.lastRun?.counters.removed).toBe(1);
    expect(collectionOf(2)).toBeUndefined();
  });

  it('旧非空库未确认 UID 时拒绝同步，不静默绑定、覆盖或删除', async () => {
    await runSync(seedCollection([1, 2]));
    const { all, dataVersion, run, getMeta } = await import('../src/db/index.js');
    run("DELETE FROM meta WHERE key='collection_owner_uid'");
    const before = all('SELECT * FROM collections ORDER BY subject_id');
    const version = dataVersion();
    const client = seedCollection([1]);
    const status = await runSync(client);
    expect(status.lastRun?.status).toBe('error');
    expect(status.lastRun?.error).toContain('归属');
    expect(client.calls).toEqual([]);
    expect(client.calls.some((call) => call.method === 'getCollectionsPage')).toBe(false);
    expect(all('SELECT * FROM collections ORDER BY subject_id')).toEqual(before);
    expect(getMeta('collection_owner_uid')).toBeNull();
    expect(dataVersion()).toBe(version);
  });

  it('首次同步写入全部收藏并完整分页', async () => {
    const ids = Array.from({ length: 123 }, (_, index) => index + 1);
    const client = seedCollection(ids);

    const status = await runSync(client, { mode: 'incremental', limits: { details: 5 } });

    expect(status.lastRun?.status).toBe('success');
    expect(status.lastRun?.counters.added).toBe(123);
    expect(countCollections()).toBe(123);
    // 123 条数据需要 3 页（每页 50），说明没有只取第一页
    const pageCalls = client.calls.filter((call) => call.method === 'getCollectionsPage');
    expect(pageCalls.length).toBeGreaterThanOrEqual(3);
    expect(status.lastRun?.counters.detailsFetched).toBe(5);
  });

  it('非空数据库拒绝跨账号同步，配置文件或环境变量改名也不能覆盖已有收藏', async () => {
    await runSync(seedCollection([1, 2]));
    const previous = collectionOf(1);
    const other = { id: 999, username: 'other-account', nickname: '', sign: '', avatar: {} };
    const client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1, rate: 1 }), makeCollectionItem({ subject_id: 3 })], users: { 'other-account': other } });
    const status = await runSync(client, { config: { username: 'other-account' } });
    expect(status.lastRun?.status).toBe('error');
    expect(status.lastRun?.error).toContain('独立数据目录');
    expect(collectionOf(1)).toEqual(previous);
    expect(collectionOf(2)).toBeTruthy();
    expect(collectionOf(3)).toBeUndefined();
    expect(client.calls.some((call) => call.method === 'getCollectionsPage')).toBe(false);
  });

  it('同账号改用户名仍按 UID 保持归属；身份查询失败时不写收藏', async () => {
    await runSync(seedCollection([1, 2]));
    const renamed = { id: 1, username: 'renamed', nickname: '', sign: '', avatar: {} };
    const status = await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })], users: { renamed } }), { config: { username: 'renamed' } });
    expect(status.lastRun?.status).toBe('success');
    expect(getMeta('collection_owner_uid')).toBe('1');
    const failed = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 3 })] });
    failed.getUser = async () => { throw new BangumiApiError('network', 'fixture identity lookup failed'); };
    expect((await runSync(failed)).lastRun?.status).toBe('error');
    expect(collectionOf(1)).toBeTruthy();
    expect(collectionOf(3)).toBeUndefined();
  });

  it('账号首次绑定与收藏同事务回滚，空收藏数据库仍允许选择另一账号', async () => {
    run(`CREATE TRIGGER audit_owner_failure BEFORE INSERT ON collections BEGIN SELECT RAISE(ABORT, 'fixture apply failure'); END`);
    try {
      expect((await runSync(seedCollection([1]))).lastRun?.status).toBe('error');
      expect(getMeta('collection_owner_uid')).toBeNull();
      expect(countCollections()).toBe(0);
    } finally { run('DROP TRIGGER audit_owner_failure'); }
    await runSync(seedCollection([]));
    const other = { id: 999, username: 'other-account', nickname: '', sign: '', avatar: {} };
    const status = await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 3 })], users: { 'other-account': other } }), { config: { username: 'other-account' } });
    expect(status.lastRun?.status).toBe('success');
    expect(getMeta('collection_owner_uid')).toBe('999');
  });

  it('重复同步不会重复写入，且能识别未变化的数据', async () => {
    const client = seedCollection([1, 2, 3]);
    await runSync(client);

    const status = await runSync(client);

    expect(status.lastRun?.counters.unchanged).toBe(3);
    expect(status.lastRun?.counters.added).toBe(0);
    expect(countCollections()).toBe(3);
  });

  it.each(['forceDetail', 'full'])('%s 会刷新已经成功抓取且仍在有效期内的详情', async (mode) => {
    await runSync(seedCollection([1]));
    const client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })], subjects: { 1: makeSubject({ id: 1, summary: 'updated upstream detail' }) } });
    await runSync(client, { mode: mode === 'full' ? 'full' : 'incremental', forceDetail: mode === 'forceDetail' });
    expect(one('SELECT summary FROM subjects WHERE id = 1')).toEqual({ summary: 'updated upstream detail' });
    expect(client.calls.filter((call) => call.method === 'getSubject')).toHaveLength(1);
  });

  it('仅补充模式写入部分详情后取消仍推进数据版本，避免旧统计缓存继续命中', async () => {
    await runSync(seedCollection([1, 2]));
    run('UPDATE subjects SET detail_synced_at = NULL');
    const before = dataVersion();
    const client = new FakeBangumiClient({ subjects: { 1: makeSubject({ id: 1, summary: 'partial enrichment committed' }) }, subjectErrors: { 2: new BangumiApiError('aborted', 'fixture cancellation') } });
    const status = await runSync(client, { mode: 'enrich' });
    expect(status.lastRun?.status).toBe('cancelled');
    expect(one('SELECT summary FROM subjects WHERE id = 1')).toEqual({ summary: 'partial enrichment committed' });
    expect(dataVersion()).toBeGreaterThan(before);
  });

  it('详情写入后人员替换失败不会留下半更新的事实、简介和人员', async () => {
    await runSync(seedCollection([1]));
    const before = one('SELECT summary, score, studios, directors FROM subjects WHERE id=1');
    const staff = all('SELECT * FROM subject_staff WHERE subject_id=1 ORDER BY rowid');
    run(`CREATE TRIGGER audit_enrich_failure BEFORE INSERT ON subject_staff WHEN NEW.subject_id=1 BEGIN SELECT RAISE(ABORT, 'fixture staff failure'); END`);
    try {
      const status = await runSync(new FakeBangumiClient({ subjects: { 1: makeSubject({ id: 1, summary: 'must roll back', rating: { score: 9, rank: 1, total: 10, count: {} } }) } }), { mode: 'enrich', forceDetail: true });
      expect(status.lastRun?.counters.detailsFetched).toBe(0);
      expect(one('SELECT summary, score, studios, directors FROM subjects WHERE id=1')).toEqual(before);
      expect(all('SELECT * FROM subject_staff WHERE subject_id=1 ORDER BY rowid')).toEqual(staff);
      expect(one('SELECT detail_state FROM subjects WHERE id=1')).toEqual({ detail_state: 'failed' });
    } finally { run('DROP TRIGGER audit_enrich_failure'); }
  });

  it('增量同步只更新发生变化的收藏', async () => {
    const ids = [1, 2, 3];
    const client = seedCollection(ids);
    await runSync(client);

    // 用户把 2 号作品的评分改成 10，并新收藏了 4 号作品
    const updatedCollections = [
      makeCollectionItem({ subject_id: 1 }),
      makeCollectionItem({ subject_id: 2, rate: 10 }),
      makeCollectionItem({ subject_id: 3 }),
      makeCollectionItem({ subject_id: 4 }),
    ];
    const second = new FakeBangumiClient({
      collections: updatedCollections,
      subjects: { 4: makeSubject({ id: 4 }) },
    });

    const status = await runSync(second);

    expect(status.lastRun?.counters.updated).toBe(1);
    expect(status.lastRun?.counters.added).toBe(1);
    expect(collectionOf(2)?.rate).toBe(10);
    expect(countCollections()).toBe(4);
  });

  it('用户取消收藏时同步对应记录的删除', async () => {
    const client = seedCollection([1, 2, 3]);
    await runSync(client);

    const smaller = seedCollection([1, 2]);
    const status = await runSync(smaller);

    expect(status.lastRun?.counters.removed).toBe(1);
    expect(countCollections()).toBe(2);
    expect(collectionOf(3)).toBeUndefined();
  });

  it('短时间内大量收藏消失时跳过删除，保护本地数据', async () => {
    const many = Array.from({ length: 300 }, (_, index) => index + 1);
    await runSync(seedCollection(many));

    // 接口只返回 1 条（例如账号异常 / 接口异常）
    const broken = seedCollection([1]);
    const status = await runSync(broken);

    expect(status.lastRun?.status).toBe('success');
    expect(status.lastRun?.counters.removed).toBe(0);
    expect(countCollections()).toBe(300);
    expect(status.lastRun?.warnings.join()).toContain('跳过删除');
  });

  it('分页中途失败时保留旧数据，不写入半截结果', async () => {
    const client = seedCollection([1, 2, 3, 4, 5]);
    await runSync(client);
    expect(countCollections()).toBe(5);

    const failing = new FakeBangumiClient({
      collections: Array.from({ length: 120 }, (_, index) => makeCollectionItem({ subject_id: index + 100 })),
      pageErrors: { 50: new BangumiApiError('server', 'Bangumi 服务端错误（HTTP 502）') },
    });
    const status = await runSync(failing);

    expect(status.lastRun?.status).toBe('error');
    expect(status.lastRun?.error).toContain('502');
    // 旧数据完好，新数据一条都没落库
    expect(countCollections()).toBe(5);
  });

  it('结构异常的收藏被跳过时，不得把本地对应收藏当作远端删除', async () => {
    await runSync(seedCollection([1, 2, 3]));
    const client = seedCollection([1]);
    vi.spyOn(client, 'getCollectionsPage').mockResolvedValue({
      total: 3, limit: 50, offset: 0,
      data: [makeCollectionItem({ subject_id: 1 }), { subject_id: 2, subject: {} }, { subject_id: 3, subject: {} }],
    });
    const status = await runSync(client);
    expect(countCollections()).toBe(3);
    expect(collectionOf(2)).toBeTruthy();
    expect(collectionOf(3)).toBeTruthy();
    expect(status.lastRun?.counters.removed).toBe(0);
    expect(status.lastRun?.warnings.join(' ')).toContain('跳过删除');
  });

  it.each([{ type: 'broken' }, { type: 0 }, { rate: 11 }, { private: 'false' }, { subject_id: 0 },
    { subject: { ...makeCollectionItem({ subject_id: 1 }).subject!, id: 2 } },
    { subject_type: 4, subject: { ...makeCollectionItem({ subject_id: 1 }).subject!, type: 4 } },
  ])(
    '语义异常的收藏不能覆盖旧状态或证明未返回收藏已删除：%j', async (invalid) => {
      await runSync(seedCollection([1, 2, 3]));
      const before = all('SELECT * FROM collections ORDER BY subject_id');
      const client = seedCollection([1]);
      vi.spyOn(client, 'getCollectionsPage').mockResolvedValue({ total: 1, limit: 50, offset: 0,
        data: [{ ...makeCollectionItem({ subject_id: 1 }), ...invalid }] });
      const status = await runSync(client);
      expect(all('SELECT * FROM collections ORDER BY subject_id')).toEqual(before);
      expect(status.lastRun?.counters.removed).toBe(0);
      expect(status.lastRun?.warnings.join(' ')).toContain('跳过删除');
    },
  );

  it.each(['提前空页', '重复分页'] as const)('%s 未覆盖 total 时保留本地未返回的收藏', async (scenario) => {
    await runSync(seedCollection([1, 2, 3]));
    const client = seedCollection([1]);
    vi.spyOn(client, 'getCollectionsPage').mockImplementation(async (_username, params) => ({
      total: 3, limit: params.limit, offset: params.offset,
      data: params.offset === 0 || scenario === '重复分页' ? [makeCollectionItem({ subject_id: 1 })] : [],
    }));
    const status = await runSync(client);
    expect(countCollections()).toBe(3);
    expect(status.lastRun?.counters.removed).toBe(0);
    expect(status.lastRun?.warnings.join(' ')).toContain('跳过删除');
  });

  it('空收藏不会报错，也不会留下脏数据', async () => {
    const status = await runSync(new FakeBangumiClient({ collections: [] }));

    expect(status.lastRun?.status).toBe('success');
    expect(countCollections()).toBe(0);
    expect(status.lastRun?.counters.added).toBe(0);
  });

  it('缺少可选字段的数据不会导致同步失败', async () => {
    const client = new FakeBangumiClient({
      collections: [
        // 完全没有 subject 字段
        { subject_id: 900, subject_type: 2, type: 1, rate: 0, ep_status: 0, vol_status: 0, private: false },
        // tags / images / score 缺失
        {
          subject_id: 901,
          subject_type: 2,
          type: 2,
          rate: 8,
          ep_status: 0,
          vol_status: 0,
          tags: [],
          subject: { id: 901, type: 2, name: 'Only Name' },
        },
        // 结构完全错误，应当被跳过
        { subject_id: 'not-a-number' },
      ],
      subjects: { 901: makeSubject({ id: 901 }) },
    });

    const status = await runSync(client);

    expect(status.lastRun?.status).toBe('success');
    expect(countCollections()).toBe(2);
    expect(status.lastRun?.warnings.join()).toContain('跳过');
    const row = one<{ name: string; name_cn: string }>(
      'SELECT name, name_cn FROM subjects WHERE id = 900',
    );
    expect(row?.name).toBe('');
  });

  it('Token 无效时给出明确提示，并且不破坏已有数据', async () => {
    await runSync(seedCollection([1, 2]));

    const client = new FakeBangumiClient({
      collections: [makeCollectionItem({ subject_id: 1 })],
    });
    client.getMe = async () => {
      throw new BangumiApiError('auth', 'Bangumi 认证失败', { hint: 'Access Token 无效或已过期' });
    };

    const status = await runSync(client, { config: { token: 'invalid-token' } });

    expect(status.lastRun?.status).toBe('error');
    expect(status.lastRun?.error).toContain('认证失败');
    expect(status.lastRun?.warnings.join()).toContain('Token');
    expect(countCollections()).toBe(2);
  });

  it('连续网络失败会自动中止同步但保留已同步数据', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => index + 1);
    const client = new FakeBangumiClient({
      collections: ids.map((id) => makeCollectionItem({ subject_id: id })),
      subjectErrors: Object.fromEntries(
        ids.map((id) => [id, new BangumiApiError('network', '网络请求失败')]),
      ),
    });

    const status = await runSync(client, { forceDetail: true });

    expect(status.lastRun?.status).toBe('error');
    expect(status.lastRun?.error).toContain('网络');
    // 收藏列表已经写入（这是可用的基础数据），详情待网络恢复后继续
    expect(countCollections()).toBe(10);
  });

  it('可以取消正在进行的同步', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => index + 1);
    const client = new FakeBangumiClient({
      collections: ids.map((id) => makeCollectionItem({ subject_id: id })),
      subjects: Object.fromEntries(ids.map((id) => [id, makeSubject({ id })])),
      delayMs: 5,
    });
    const engine = new SyncEngine({ client, getConfig: () => testConfig() });
    engine.start({ mode: 'incremental' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.cancel()).toBe(true);
    await engine.whenIdle();

    const status = engine.getStatus();
    expect(['cancelled', 'success']).toContain(status.lastRun?.status);
    expect(status.running).toBe(false);
  });

  it('深度 2 同步会抓取系列关系与制作人员，并生成系列分组', async () => {
    const ids = [1, 2, 3];
    const client = new FakeBangumiClient({
      collections: ids.map((id) => makeCollectionItem({ subject_id: id })),
      subjects: Object.fromEntries(ids.map((id) => [id, makeSubject({ id })])),
      relations: {
        1: [
          { id: 2, type: 2, name: 'Test Anime 2', name_cn: '测试动画 2', relation: '续集' },
        ],
        2: [
          { id: 1, type: 2, name: 'Test Anime 1', name_cn: '测试动画 1', relation: '前传' },
        ],
        3: [],
      },
      persons: {
        1: [
          { id: 11, name: '石原立也', relation: '导演', career: ['导演'], type: 1 },
          { id: 12, name: '京都动画', relation: '动画制作', career: [], type: 2 },
        ],
      },
    });

    const status = await runSync(client, { depth: 2 });

    expect(status.lastRun?.status).toBe('success');
    expect(status.lastRun?.counters.relationsFetched).toBe(3);
    expect(status.lastRun?.counters.personsFetched).toBe(3);

    const series = all<{ key: string; title: string; state: string; member_count: number }>(
      'SELECT key, title, state, member_count FROM series_entities WHERE member_count >= 2 ORDER BY key',
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.state).toBe('stable');
    expect(series[0]?.member_count).toBe(2);
    expect(series[0]?.key.startsWith('sr_')).toBe(true);

    const subject = one<{ series_key: string | null; directors: string; studios: string }>(
      'SELECT series_key, directors, studios FROM subjects WHERE id = 1',
    );
    expect(subject?.series_key).toBe(series[0]?.key);
    expect(JSON.parse(subject?.directors ?? '[]')).toContain('石原立也');
    expect(JSON.parse(subject?.studios ?? '[]')).toContain('京都动画');
    // 单成员系列在数据层同样存在（默认列表隐藏）
    const singletons = all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM series_entities WHERE member_count = 1',
    );
    expect(Number(singletons[0]?.n ?? 0)).toBe(1);
  });

  it('官方关系缺失时使用标题启发式分组，并标记为推测', async () => {
    const client = new FakeBangumiClient({
      collections: [
        makeCollectionItem({
          subject_id: 1,
          subject: {
            id: 1,
            type: 2,
            name: '進撃の巨人',
            name_cn: '进击的巨人',
            short_summary: '',
            date: '2013-04-07',
            images: {},
            volumes: 0,
            eps: 25,
            collection_total: 100,
            score: 8,
            rank: 10,
            tags: [],
          },
        }),
        makeCollectionItem({
          subject_id: 2,
          subject: {
            id: 2,
            type: 2,
            name: '進撃の巨人 Season 2',
            name_cn: '进击的巨人 第二季',
            short_summary: '',
            date: '2017-04-01',
            images: {},
            volumes: 0,
            eps: 12,
            collection_total: 100,
            score: 8,
            rank: 20,
            tags: [],
          },
        }),
      ],
      subjects: {
        1: makeSubject({ id: 1, name: '進撃の巨人', name_cn: '进击的巨人' }),
        2: makeSubject({ id: 2, name: '進撃の巨人 Season 2', name_cn: '进击的巨人 第二季' }),
      },
    });

    await runSync(client, { depth: 2 });

    const series = all<{ key: string; state: string; member_count: number; title: string }>(
      'SELECT key, state, member_count, title FROM series_entities',
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.state).toBe('provisional');
    expect(series[0]?.member_count).toBe(2);
    expect(series[0]?.title).toContain('进击的巨人');
  });
});
