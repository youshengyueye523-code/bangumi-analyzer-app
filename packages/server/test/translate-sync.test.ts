import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BgmSubject } from "@bangumi-analyzer/shared";
import { buildApp } from "../src/app.js";
import { CoverCache } from "../src/images/coverCache.js";
import { SyncEngine } from "../src/sync/engine.js";
import { TranslationWorker } from "../src/translate/worker.js";
import { countJobs } from "../src/db/translationJobs.js";
import { getSummaryRecord } from "../src/db/summaries.js";
import { one } from "../src/db/index.js";
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, testConfig } from "./helpers.js";

/**
 * 同步 → 简介入队 的集成测试。
 *
 * 目标：验证「新作品进入收藏后自动进入翻译队列」，
 * 并且 AI 不可用时同步照常成功、翻译任务只是排队。
 */

const JA_SUMMARY =
  "「かぐや様は告らせたい」の赤坂アカ原作による人気コミックをアニメ化した作品。秀知院学園の生徒会で繰り広げられる恋愛頭脳戦を描く。";
const ZH_SUMMARY =
  "2021年，随着超光速航行技术的实现，人类得以在太阳系范围内方便的自由移动，但是由于设计上的失误，这种技术引发了月球的爆炸。";

let app: FastifyInstance;
let client: FakeBangumiClient;
let engine: SyncEngine;
let worker: TranslationWorker;
/** 可变数据源：模拟「同步后新增收藏」 */
const collections: BgmCollectionItem[] = [];
const subjects: Record<number, BgmSubject> = {};

function subjectWithSummary(id: number, summary: string): BgmSubject {
  return makeSubject({ id, summary, name: `作品 ${id}`, name_cn: `作品 ${id}` });
}

async function syncOnce(mode: "full" | "incremental" = "incremental"): Promise<void> {
  engine.start({ mode, depth: 1 });
  await engine.whenIdle();
}

beforeAll(async () => {
  const summaries: Record<number, string> = { 101: JA_SUMMARY, 102: ZH_SUMMARY, 103: "" };
  for (const id of [101, 102, 103]) {
    collections.push(
      makeCollectionItem({
        subject_id: id,
        type: 2,
        subject: {
          id,
          type: 2,
          name: `作品 ${id}`,
          name_cn: `作品 ${id}`,
          short_summary: summaries[id] ?? "",
          date: "2020-01-01",
          images: {},
          volumes: 0,
          eps: 12,
          collection_total: 10,
          score: 7,
          rank: 10,
          tags: [],
        },
      }),
    );
    subjects[id] = subjectWithSummary(id, summaries[id] ?? "");
  }
  client = new FakeBangumiClient({ collections, subjects });
  engine = new SyncEngine({ client, getConfig: () => testConfig(), limits: { details: 100 } });
  // worker 不启动（只验证「入队与状态」），但必须注册，接口才可用
  worker = new TranslationWorker({
    getConfig: () => ({ ...testConfig().ai, enabled: false, apiKey: "" }),
    concurrency: () => 1,
  });
  app = await buildApp({
    deps: { client, engine, coverCache: new CoverCache(client), translationWorker: worker },
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await worker.stop();
});

beforeEach(() => {
  resetDatabase();
});

describe("同步与简介翻译解耦", () => {
  it("同步完成后：日文简介入队、官方中文不入队、无简介不入队", async () => {
    await syncOnce();
    expect(countJobs().pending).toBe(1);
    expect(countJobs().completed).toBe(0);

    const japanese = getSummaryRecord(101);
    expect(japanese?.language).toBe("ja");
    expect(japanese?.original).toBe(JA_SUMMARY);
    expect(japanese?.status).toBe("pending");
    expect(japanese?.chinese).toBe("");

    const chinese = getSummaryRecord(102);
    expect(chinese?.language).toBe("zh");
    expect(chinese?.chineseSource).toBe("bangumi");
    expect(chinese?.chinese).toBe(ZH_SUMMARY);
    expect(chinese?.status).toBe("idle");

    const empty = getSummaryRecord(103);
    expect(empty?.original).toBe("");
    expect(empty?.chinese).toBe("");
    expect(empty?.translatable).toBe(false);
  });

  it("收藏数据在没有 AI 的情况下完整写入（翻译不影响同步）", async () => {
    await syncOnce();
    expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM collections")?.count).toBe(3);
    expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM subjects")?.count).toBe(3);
  });

  it("重复同步不会重复创建任务（不重复消耗 token）", async () => {
    await syncOnce();
    const firstJobs = one<{ count: number }>("SELECT COUNT(*) AS count FROM translation_jobs")?.count;
    await syncOnce();
    const secondJobs = one<{ count: number }>("SELECT COUNT(*) AS count FROM translation_jobs")?.count;
    expect(firstJobs).toBe(1);
    expect(secondJobs).toBe(1);
    expect(countJobs().pending).toBe(1);
  });


  it("HTTP 接口返回简介双语状态与队列总览", async () => {
    await syncOnce();
    const detail = await app.inject({ method: "GET", url: "/api/subjects/101" });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.summaryState.originalLanguage).toBe("ja");
    expect(body.summaryState.translatable).toBe(true);
    expect(body.summaryState.original).toBe(JA_SUMMARY);
    expect(body.summary).toBe(JA_SUMMARY);

    const zh = (await app.inject({ method: "GET", url: "/api/subjects/102" })).json();
    expect(zh.summaryState.chineseSource).toBe("bangumi");
    expect(zh.summaryState.chinese).toBe(ZH_SUMMARY);

    const status = await app.inject({ method: "GET", url: "/api/translate/summary" });
    expect(status.statusCode).toBe(200);
    const payload = status.json();
    expect(payload.counts.pending).toBe(1);
    expect(payload.totals.bySourceLanguage.ja).toBe(1);
    expect(payload.totals.officialChinese).toBe(1);
    // 两个统计口径互不重叠：按原文语言求和 = 收藏总数
    const byLanguage = Object.values(payload.totals.bySourceLanguage as Record<string, number>).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(byLanguage).toBe(3);
  });

  it("中文简介条目请求翻译会被明确拒绝（不调用 AI）", async () => {
    await syncOnce();
    const response = await app.inject({ method: "POST", url: "/api/translate/subjects/102" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("translation_unsupported");
  });

  it("没有简介的条目请求翻译会被拒绝", async () => {
    await syncOnce();
    const response = await app.inject({ method: "POST", url: "/api/translate/subjects/103" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("summary_missing");
  });

  /**
   * 批量涌入：一次新增 20 部作品（等价于更大批量的同一路径），
   * 全部先写进数据库，然后逐个入队；同步本身不受翻译影响。
   *
   * 放在最后执行：它会向共享的假数据源追加收藏，避免影响前面的用例。
   */
  it("批量新增作品：先全部入库，再逐条入队", async () => {
    for (let id = 200; id < 220; id += 1) {
      collections.push(
        makeCollectionItem({
          subject_id: id,
          type: 2,
          subject: {
            id,
            type: 2,
            name: `作品 ${id}`,
            name_cn: `作品 ${id}`,
            short_summary: JA_SUMMARY,
            date: "2021-01-01",
            images: {},
            volumes: 0,
            eps: 12,
            collection_total: 5,
            score: 7,
            rank: 1,
            tags: [],
          },
        }),
      );
      subjects[id] = subjectWithSummary(id, JA_SUMMARY);
    }
    await syncOnce();
    // 20 部新作品 + 之前的日文作品
    expect(countJobs().pending).toBe(21);
    expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM collections")?.count).toBe(23);
    expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM subjects WHERE summary_original_lang = 'ja'")?.count).toBe(21);
  });
});
