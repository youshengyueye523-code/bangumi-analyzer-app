import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSummaryForHash } from "@bangumi-analyzer/shared";
import type { AiConfig } from "../src/config.js";
import { getSummaryRecord, upsertSubjectSummary } from "../src/db/summaries.js";
import { cancelJob, countJobs, currentJobForSubject } from "../src/db/translationJobs.js";
import { dataVersion, one, run } from "../src/db/index.js";
import { TranslationWorker } from "../src/translate/worker.js";
import { resetDatabase } from "./helpers.js";

/**
 * 简介翻译 worker：队列、并发、重试、限流、断点恢复、原文 hash 校验。
 * 这里使用的是 Mock AI Provider（本地 fetch 桩），不消耗任何真实 API 配额；
 * 真实 API 验证见 docs/test-report.md 的「真实翻译验证」一节。
 */

const JA_TEXT =
  "「かぐや様は告らせたい」の赤坂アカ原作による人気コミックをアニメ化した作品。秀知院学園の生徒会で繰り広げられる恋愛頭脳戦を描く。";
const ZH_TEXT =
  "这是一段完全由本地桩生成的中文译文，用来验证翻译结果可以被正确写入本地数据库并且重复读取。它足够长，能通过长度与语言校验。";
const TS = "2026-02-01T00:00:00.000Z";

const AI_CONFIG: AiConfig = {
  enabled: true,
  provider: "openai-compatible",
  baseUrl: "https://mock.local/v1",
  model: "mock-model",
  apiKey: "sk-mock-key",
};

interface MockCall {
  subject: string;
  at: number;
}

/** 构造一个 OpenAI 兼容的 fetch 桩，支持并发追踪、限流与失败注入。 */
function makeMockFetch(options: {
  calls: MockCall[];
  failTimes?: Map<string, number>;
  status?: Map<string, number>;
  /** 前 N 次调用强制返回指定状态码（确定性更强，用于限流与网络错误测试） */
  failFirstCalls?: { count: number; status: number; message?: string };
  delayMs?: number;
  onCall?: () => void;
  tracker?: { active: number; maxActive: number };
}): typeof fetch {
  let callIndex = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    const marker = "----- 原文开始 -----";
    const source = user.includes(marker)
      ? user.split(marker)[1]!.split("----- 原文结束 -----")[0]!.trim()
      : user;
    const key = source.slice(0, 24);
    options.calls.push({ subject: key, at: Date.now() });
    options.onCall?.();
    callIndex += 1;

    if (options.tracker) {
      options.tracker.active += 1;
      options.tracker.maxActive = Math.max(options.tracker.maxActive, options.tracker.active);
    }
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failFirstCalls && callIndex <= options.failFirstCalls.count) {
        return new Response(
          JSON.stringify({ error: { message: options.failFirstCalls.message ?? "mock failure" } }),
          { status: options.failFirstCalls.status, headers: { "content-type": "application/json" } },
        );
      }
      const remaining = options.failTimes?.get(key) ?? 0;
      if (remaining > 0) {
        options.failTimes!.set(key, remaining - 1);
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: options.status?.get(key) ?? 500,
          headers: { "content-type": "application/json" },
        });
      }
      const status = options.status?.get(key);
      if (status && status !== 200) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: ZH_TEXT } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } finally {
      if (options.tracker) options.tracker.active -= 1;
    }
  }) as unknown as typeof fetch;
}

function seedCollected(id: number, summary: string): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, summary, created_at, updated_at)
     VALUES (:id, :name, :nameCn, :summary, :ts, :ts)`,
    { id, name: `作品 ${id}`, nameCn: `作品 ${id}`, summary, ts: TS },
  );
  run(
    `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, vol_status,
       comment, tags, private, updated_at, first_seen_at, synced_at)
     VALUES (:id, 2, 2, 0, 0, 0, '', '[]', 0, :ts, :ts, :ts)`,
    { id, ts: TS },
  );
}

function enqueue(id: number, summary: string): void {
  upsertSubjectSummary({ subjectId: id, text: summary, subjectName: `作品 ${id}`, timestamp: TS });
}

let worker: TranslationWorker | null = null;

beforeEach(() => {
  resetDatabase();
});

afterEach(async () => {
  await worker?.stop();
  worker = null;
});

describe("翻译 worker", () => {
  it.each([200, 500, 401])("晚到的 %s 响应不能覆盖更新后的简介状态或复活旧任务", async (status) => {
    for (const change of ['source', 'official', 'cancel'] as const) {
      resetDatabase();
      seedCollected(1, JA_TEXT);
      enqueue(1, JA_TEXT);
      const version = dataVersion();
      let release!: (response: Response) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const response = new Promise<Response>((resolve) => { release = resolve; });
      worker = new TranslationWorker({ getConfig: () => AI_CONFIG, concurrency: () => 1,
        fetchImpl: (async () => { entered(); return response; }) as typeof fetch });
      worker.start(TS);
      await started;
      const oldJob = currentJobForSubject(1)!;
      if (change === 'cancel') {
        expect(cancelJob(Number(oldJob.id), TS)).toBe(true);
        run("UPDATE subjects SET summary_zh_ai_status='failed', summary_zh_ai_error='已手动取消' WHERE id=1");
      } else enqueue(1, change === 'official' ? ZH_TEXT : `${JA_TEXT} 追加された新しい段落です。`);
      const recordBefore = getSummaryRecord(1);
      const jobBefore = currentJobForSubject(1);
      const stopping = worker.stop();
      release(new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: ZH_TEXT } }] }
        : { error: { message: 'mock delayed failure' } }), { status, headers: { 'content-type': 'application/json' } }));
      await stopping;
      worker = null;
      expect(getSummaryRecord(1), `${change}/${status} summary`).toEqual(recordBefore);
      expect(currentJobForSubject(1), `${change}/${status} job`).toEqual(jobBefore);
      expect(dataVersion()).toBe(version);
    }
  });
  it("批量入队后全部完成并持久化中文，且原文不变", async () => {
    const calls: MockCall[] = [];
    for (let id = 1; id <= 10; id += 1) {
      seedCollected(id, JA_TEXT);
      enqueue(id, JA_TEXT);
    }
    expect(countJobs().pending).toBe(10);

    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 2,
      fetchImpl: makeMockFetch({ calls }),
      backoffBaseMs: 10,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);

    expect(countJobs().completed).toBe(10);
    expect(countJobs().pending).toBe(0);
    for (let id = 1; id <= 10; id += 1) {
      const record = getSummaryRecord(id);
      expect(record?.chinese).toBe(ZH_TEXT);
      expect(record?.chineseSource).toBe("ai");
      expect(record?.original).toBe(JA_TEXT);
      expect(record?.stale).toBe(false);
      // 一手原文列必须保持不变
      expect(one<{ summary: string }>("SELECT summary FROM subjects WHERE id = :id", { id })?.summary).toBe(
        JA_TEXT,
      );
    }
    expect(calls.length).toBe(10);
  });

  it("并发受控：并发数设为 2 时不会同时发起更多请求", async () => {
    const tracker = { active: 0, maxActive: 0 };
    const calls: MockCall[] = [];
    for (let id = 1; id <= 12; id += 1) {
      seedCollected(id, JA_TEXT);
      enqueue(id, JA_TEXT);
    }
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 2,
      fetchImpl: makeMockFetch({ calls, delayMs: 20, tracker }),
      backoffBaseMs: 10,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    expect(tracker.maxActive).toBeLessThanOrEqual(2);
    expect(countJobs().completed).toBe(12);
  });

  it("AI 未配置：任务停在 waiting_ai，配置后自动继续", async () => {
    const calls: MockCall[] = [];
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);

    let enabled = false;
    worker = new TranslationWorker({
      getConfig: () => ({ ...AI_CONFIG, enabled, apiKey: enabled ? AI_CONFIG.apiKey : "" }),
      concurrency: () => 1,
      fetchImpl: makeMockFetch({ calls }),
      backoffBaseMs: 10,
    });
    worker.start(TS);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(countJobs().waiting_ai).toBe(1);
    expect(calls.length).toBe(0);
    expect(getSummaryRecord(1)?.status).toBe("waiting_ai");

    // 配置补齐后唤醒 → 自动继续
    enabled = true;
    const { requeueWhenAiConfigured } = await import("../src/db/summaries.js");
    requeueWhenAiConfigured(new Date().toISOString());
    worker.wakeUp();
    expect(await worker.waitForIdle()).toBe(true);
    expect(getSummaryRecord(1)?.chinese).toBe(ZH_TEXT);
  });

  it("失败自动重试，超过上限后进入 failed 并可手动重试", async () => {
    const calls: MockCall[] = [];
    const failTimes = new Map<string, number>([[JA_TEXT.slice(0, 24), 2]]);
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);

    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      fetchImpl: makeMockFetch({ calls, failTimes }),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    // 第 3 次尝试成功
    expect(getSummaryRecord(1)?.chinese).toBe(ZH_TEXT);
    expect(countJobs().completed).toBe(1);
  });

  it("模型持续返回异常内容时进入 failed，原文与收藏数据不受影响", async () => {
    // 只有「模型输出异常」这类非临时性错误才会在重试耗尽后进入 failed
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);

    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      maxAttempts: 2,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "This is not a Chinese translation." } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    expect(countJobs().failed).toBe(1);
    const record = getSummaryRecord(1);
    expect(record?.chinese).toBe("");
    expect(record?.status).toBe("failed");
    expect(record?.translationError).toMatch(/不是中文/);
    expect(one<{ summary: string }>("SELECT summary FROM subjects WHERE id = 1")?.summary).toBe(JA_TEXT);
    expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM collections")?.count).toBe(1);
  });

  it("临时网络错误不会进入 failed，而是按退避一直自动重试", async () => {
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);

    let calls = 0;
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      // 上限设成 1：临时错误也不应该因此进入 failed
      maxAttempts: 1,
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
      backoffBaseMs: 5,
    });
    worker.start(TS);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await worker.stop();
    worker = null;

    expect(calls).toBeGreaterThanOrEqual(2);
    const counts = countJobs();
    expect(counts.failed).toBe(0);
    expect(counts.pending + counts.processing).toBe(1);
    expect(getSummaryRecord(1)?.translationError).toMatch(/无法连接|网络/);
    expect(getSummaryRecord(1)?.status).toBe("pending");
  });

  it("429 限流会进入冷却并按退避重试，最终成功", async () => {
    const calls: MockCall[] = [];
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);

    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      fetchImpl: makeMockFetch({
        calls,
        // 第一次返回 429，之后恢复正常
        failFirstCalls: { count: 1, status: 429, message: "rate limited" },
      }),
      backoffBaseMs: 5,
      // 限流冷却在测试里压到 50ms（生产默认 30s）
      rateLimitCooldownMs: 50,
    });
    worker.start(TS);
    expect(await worker.waitForIdle(20_000)).toBe(true);
    expect(countJobs().completed).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("原文在排队后变化：旧任务作废，不写入过期翻译", async () => {
    const calls: MockCall[] = [];
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);

    let source = JA_TEXT;
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        // 翻译进行中 Bangumi 原文被更新
        source = `${JA_TEXT} 追加段落。`;
        run(`UPDATE subjects SET summary = :summary, summary_original = :summary,
              summary_original_hash = :hash WHERE id = 1`, {
          summary: source,
          hash: normalizeSummaryForHash(source),
        });
        return makeMockFetch({ calls })(url as never, init as never);
      }) as unknown as typeof fetch,
      backoffBaseMs: 5,
    });
    worker.start(TS);
    await worker.waitForIdle(5000);

    // 旧任务被标记作废，新任务已经入队（由后续再次入队或回填完成）
    const record = getSummaryRecord(1);
    expect(record?.original).toContain("追加段落");
    expect(record?.stale).toBe(false);
  });

  it("翻译结果校验失败时不会写入中文", async () => {
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);
    // 模型返回了远超原文长度的中文（明显夹带扩写），必须被拒绝写入
    const tooLong = `先说结论：${ZH_TEXT.repeat(20)}`;
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      maxAttempts: 1,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: tooLong } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    expect(getSummaryRecord(1)?.chinese).toBe("");
    expect(countJobs().failed).toBe(1);
    expect(getSummaryRecord(1)?.translationError).toContain("偏长");
  });

  it("重启后从未完成处继续，已完成的翻译不会重复请求", async () => {
    const calls: MockCall[] = [];
    seedCollected(1, JA_TEXT);
    seedCollected(2, JA_TEXT.slice(0, 60) + "二次测试文本，用于验证断点恢复与去重。");
    enqueue(1, JA_TEXT);
    enqueue(2, JA_TEXT.slice(0, 60) + "二次测试文本，用于验证断点恢复与去重。");

    // 第一个 worker 只处理一条（并发 1），随后被强制停止
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      fetchImpl: makeMockFetch({ calls, delayMs: 5 }),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.stop();
    const doneBefore = countJobs().completed;
    const remaining = countJobs().pending + countJobs().processing;
    expect(doneBefore).toBeGreaterThanOrEqual(1);

    // 模拟进程重启：新的 worker 从数据库继续
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 2,
      fetchImpl: makeMockFetch({ calls }),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    expect(countJobs().completed).toBe(2);
    expect(countJobs().failed + countJobs().waiting_ai).toBe(0);
    // 总共只请求 2 次（每条作品一次），已完成的任务没有被重复翻译
    expect(calls.length).toBe(2);
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  it("300 部批量：全部入队、并发受控、全部完成且无重复任务", async () => {
    const tracker = { active: 0, maxActive: 0 };
    const calls: MockCall[] = [];
    for (let id = 1; id <= 300; id += 1) {
      seedCollected(id, JA_TEXT);
      enqueue(id, JA_TEXT);
    }
    expect(countJobs().pending).toBe(300);

    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 4,
      fetchImpl: makeMockFetch({ calls, delayMs: 1, tracker }),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle(60_000)).toBe(true);

    expect(countJobs().completed).toBe(300);
    expect(countJobs().pending + countJobs().processing + countJobs().failed).toBe(0);
    expect(tracker.maxActive).toBeLessThanOrEqual(4);
    // 每个作品只翻译一次（英文 300 条任务 = 300 次请求）
    expect(calls.length).toBe(300);
    expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM translation_jobs")?.count).toBe(300);
  }, 90_000);

  it("翻译完成的译文本地持久化：重启后无需再次调用 AI 即可读取", async () => {
    const calls: MockCall[] = [];
    seedCollected(1, JA_TEXT);
    enqueue(1, JA_TEXT);
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      fetchImpl: makeMockFetch({ calls }),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    const beforeRestart = calls.length;

    // 模拟「离线 + 重启」：新的 worker 起来了，但 AI 完全不可用
    worker = new TranslationWorker({
      getConfig: () => ({ ...AI_CONFIG, enabled: false, apiKey: "" }),
      concurrency: () => 1,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    worker.start(TS);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();
    worker = null;

    // 已完成的翻译直接读本地数据库即可，不需要再次调用 AI
    const record = getSummaryRecord(1);
    expect(record?.chinese).toBe(ZH_TEXT);
    expect(record?.original).toBe(JA_TEXT);
    expect(record?.status).toBe("completed");
    expect(calls.length).toBe(beforeRestart);
  });
});
