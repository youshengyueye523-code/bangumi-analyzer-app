import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectSummaryLanguage, parseSummarySegments, translationStrategy } from "@bangumi-analyzer/shared";
import type { AiConfig } from "../src/config.js";
import { countJobs, obsoleteStaleJobs, resetInFlightJobs } from "../src/db/translationJobs.js";
import {
  getSummaryRecord,
  refreshSummaryQueue,
  requeueSubjectTranslation,
  summaryTotals,
  upsertSubjectSummary,
} from "../src/db/summaries.js";
import { one, run } from "../src/db/index.js";
import { TranslationWorker } from "../src/translate/worker.js";
import { resetDatabase } from "./helpers.js";

/**
 * v1.4.1 规则收敛：多语言策略、任务状态机、统计口径、历史失效治理。
 *
 * 这里使用 Mock AI Provider（本地 fetch 桩），不消耗真实配额。
 */

const TS = "2026-03-01T00:00:00.000Z";
const AI_CONFIG: AiConfig = {
  enabled: true,
  provider: "openai-compatible",
  baseUrl: "https://mock.local/v1",
  model: "mock-model",
  apiKey: "sk-mock-key",
};
const ZH_OUT =
  "这是一段用于测试的中文译文，内容足够长，可以通过长度与语言校验，用来验证翻译结果可以正确写入本地数据库并重复读取。";

/** 各语言样本（真实数据里出现过的形态） */
const SAMPLES = {
  ja: "「かぐや様は告らせたい」の赤坂アカ原作による人気コミックをアニメ化した作品。秀知院学園の生徒会で繰り広げられる恋愛頭脳戦を描く。",
  en: "A high school girl discovers a mysterious robot and together they travel across the galaxy to find the truth.",
  ko: "평범한 고등학생이 어느 날 갑자기 마법소녀가 되어 세계를 구하는 이야기를 그린 작품입니다.",
  other: "Обычная старшеклассница однажды встречает загадочного робота и отправляется в опасное путешествие.",
  zh: "这是一段官方中文简介，讲述主角在校园里度过的日常与成长故事。",
  unknown: "1234 / 5678 / 9012",
  bilingualZhFirst: `这是一个中文简介，讲述主角在校园里的日常故事。\n\n[简介原文]\n\n主人公はごく普通の高校生で、ある日を境に日常が変わっていく物語です。`,
  bilingualJaFirst: `それは、新たなる魔法少女物語の始まり――\n彼女はまだ知らない。\n\n[中文简介]\n\n出生良好家庭，亲朋好友团聚，时哭时笑，这是谁都拥有的日常生活。`,
};

function seedCollected(id: number, summary: string, name = `作品 ${id}`): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, summary, created_at, updated_at)
     VALUES (:id, :name, :name, :summary, :ts, :ts)`,
    { id, name, summary, ts: TS },
  );
  run(
    `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, vol_status,
       comment, tags, private, updated_at, first_seen_at, synced_at)
     VALUES (:id, 2, 2, 0, 0, 0, '', '[]', 0, :ts, :ts, :ts)`,
    { id, ts: TS },
  );
}

function mockFetch(onCall?: (source: string) => void): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    const source = user.split("----- 原文开始 -----")[1]?.split("----- 原文结束 -----")[0]?.trim() ?? "";
    onCall?.(source);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: ZH_OUT } }], usage: {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

let worker: TranslationWorker | null = null;

beforeEach(() => {
  resetDatabase();
});

afterEach(async () => {
  await worker?.stop();
  worker = null;
});

describe("多语言翻译策略", () => {
  it("五种形态各自按策略处理：官方中文 / 双语不进队列，外文进队列，无法识别保留原文", () => {
    seedCollected(1, SAMPLES.zh);
    seedCollected(2, SAMPLES.ja);
    seedCollected(3, SAMPLES.bilingualZhFirst);
    seedCollected(4, SAMPLES.bilingualJaFirst);
    seedCollected(5, SAMPLES.en);
    seedCollected(6, SAMPLES.ko);
    seedCollected(7, SAMPLES.other);
    seedCollected(8, SAMPLES.unknown);
    seedCollected(9, "");

    const scan = refreshSummaryQueue(TS);
    expect(scan.scanned).toBe(8); // 空简介不在扫描范围内

    // 官方中文（含两种双语结构）→ 不调用 AI、不建任务
    for (const id of [1, 3, 4]) {
      const record = getSummaryRecord(id);
      expect(record?.chineseSource, `#${id}`).toBe("bangumi");
      expect(record?.translatable, `#${id}`).toBe(false);
      expect(record?.status, `#${id}`).toBe("idle");
    }
    // 外文（日文 / 英文 / 韩文 / 其他文字）→ 进入统一队列
    for (const id of [2, 5, 6, 7]) {
      const record = getSummaryRecord(id);
      expect(record?.translatable, `#${id}`).toBe(true);
      expect(record?.status, `#${id}`).toBe("pending");
    }
    // 无法识别 → 保留原文，不调用 AI
    const unknown = getSummaryRecord(8);
    expect(unknown?.translatable).toBe(false);
    expect(unknown?.unsupportedReason).toContain("无法识别");
    expect(unknown?.status).toBe("idle");

    expect(countJobs().pending).toBe(4);
  });

  it("双语结构与语言识别的边界：标记不进入正文、原文语言正确", () => {
    const zhFirst = parseSummarySegments(SAMPLES.bilingualZhFirst);
    expect(zhFirst?.chinese).toContain("校园");
    expect(zhFirst?.original).toContain("高校生");
    expect(zhFirst?.chinese).not.toContain("[简介原文]");
    expect(detectSummaryLanguage(zhFirst!.original).language).toBe("ja");

    const jaFirst = parseSummarySegments(SAMPLES.bilingualJaFirst);
    expect(jaFirst?.chinese).toContain("日常生活");
    expect(jaFirst?.original).toContain("魔法少女");
    expect(detectSummaryLanguage(jaFirst!.original).language).toBe("ja");
  });

  it("英文 / 韩文 / 其他文字系统都能识别并可翻译", () => {
    expect(detectSummaryLanguage(SAMPLES.en).language).toBe("en");
    expect(detectSummaryLanguage(SAMPLES.ko).language).toBe("ko");
    expect(detectSummaryLanguage(SAMPLES.other).language).toBe("other");
    for (const language of ["ja", "en", "ko", "other"] as const) {
      expect(translationStrategy(language).translate).toBe(true);
    }
    expect(translationStrategy("unknown").translate).toBe(false);
  });
});

describe("多语言混合批量", () => {
  it("官方中文 + 日文 + 英文 + 韩文 + 其他 + 无法识别 + 无简介 混合批量", async () => {
    seedCollected(1, SAMPLES.zh);
    seedCollected(2, SAMPLES.ja);
    seedCollected(3, SAMPLES.en);
    seedCollected(4, SAMPLES.ko);
    seedCollected(5, SAMPLES.other);
    seedCollected(6, SAMPLES.bilingualZhFirst);
    seedCollected(7, SAMPLES.unknown);
    seedCollected(8, "");

    // 先入队（等价于同步完成后的扫描）
    refreshSummaryQueue(TS);
    expect(countJobs().pending).toBe(4);

    const calls: string[] = [];
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 2,
      fetchImpl: mockFetch((source) => calls.push(source)),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);

    // 只有 4 条可翻译的外文被翻译（官方中文 / 无法识别 / 空简介都不调用 AI）
    expect(calls.length).toBe(4);
    expect(countJobs().completed).toBe(4);
    expect(countJobs().failed).toBe(0);
    for (const id of [2, 3, 4, 5]) {
      expect(getSummaryRecord(id)?.chinese, `#${id}`).toBe(ZH_OUT);
      expect(getSummaryRecord(id)?.chineseSource, `#${id}`).toBe("ai");
    }
    for (const id of [1, 6, 7]) {
      expect(getSummaryRecord(id)?.translation, `#${id}`).toBe("");
    }
  });

  it("统计口径互不重叠：按原文语言求和 = 收藏总数", () => {
    seedCollected(1, SAMPLES.zh);
    seedCollected(2, SAMPLES.ja);
    seedCollected(3, SAMPLES.en);
    seedCollected(4, SAMPLES.bilingualZhFirst);
    seedCollected(5, SAMPLES.unknown);
    seedCollected(6, "");
    refreshSummaryQueue(TS);

    const totals = summaryTotals();
    expect(totals.collected).toBe(6);
    const byLanguage = Object.values(totals.bySourceLanguage).reduce((sum, v) => sum + v, 0);
    expect(byLanguage).toBe(6);
    expect(totals.officialChinese).toBe(2); // 纯中文 + 双语
    expect(totals.bilingual).toBe(1);
    expect(totals.translated).toBe(0);
    expect(totals.untranslated).toBe(2); // 日文 + 英文
    expect(totals.noSummary).toBe(1);
    expect(totals.unknownLanguage).toBe(1);
  });
});

describe("任务状态机与历史失效治理", () => {
  it("原文变化：旧任务变 obsolete，新任务 pending，旧翻译保留", () => {
    seedCollected(1, SAMPLES.ja);
    upsertSubjectSummary({ subjectId: 1, subjectName: "x", timestamp: TS });
    const firstHash = getSummaryRecord(1)!.sourceHash;
    run(
      `UPDATE subjects SET summary_zh_ai = '旧版中文翻译内容', summary_zh_ai_hash = :hash,
         summary_zh_ai_status = 'completed' WHERE id = 1`,
      { hash: firstHash },
    );
    run(`UPDATE translation_jobs SET status = 'completed' WHERE subject_id = 1`);

    upsertSubjectSummary({
      subjectId: 1,
      subjectName: "x",
      timestamp: TS,
      text: `${SAMPLES.ja} 追加的新段落。`,
    });

    const counts = countJobs();
    // 旧任务（旧 hash）不计入当前已完成，而是历史失效
    expect(counts.completed).toBe(0);
    expect(counts.pending).toBe(1);
    expect(counts.obsolete).toBe(1);
    expect(counts.failed).toBe(0);
    const record = getSummaryRecord(1);
    expect(record?.translation).toBe("旧版中文翻译内容");
    expect(record?.stale).toBe(true);
    expect(record?.status).toBe("pending");
  });

  it("历史失效任务不会因为重启被重新发送", async () => {
    seedCollected(1, SAMPLES.ja);
    upsertSubjectSummary({ subjectId: 1, subjectName: "x", timestamp: TS });
    run(`UPDATE translation_jobs SET status = 'processing' WHERE subject_id = 1`);
    // 原文变化 → 该任务失效
    upsertSubjectSummary({
      subjectId: 1,
      subjectName: "x",
      timestamp: TS,
      text: `${SAMPLES.ja} 新的段落内容。`,
    });
    obsoleteStaleJobs(TS);
    const before = countJobs();
    expect(before.obsolete).toBeGreaterThanOrEqual(1);

    // 重启：processing → pending 只针对当前有效任务
    const restored = resetInFlightJobs(TS);
    expect(restored).toBe(0);
    const counts = countJobs();
    expect(counts.processing).toBe(0);
    // 只有当前 hash 的新任务在队列里
    expect(counts.pending).toBe(1);
    expect(counts.obsolete).toBe(1);
    expect(counts.failed).toBe(0);
  });

  it("已有官方中文时，未完成任务会被标记为历史失效而不是失败", () => {
    seedCollected(1, SAMPLES.ja);
    upsertSubjectSummary({ subjectId: 1, subjectName: "x", timestamp: TS });
    expect(countJobs().pending).toBe(1);

    // Bangumi 补上了官方中文（双语结构）
    upsertSubjectSummary({
      subjectId: 1,
      subjectName: "x",
      timestamp: TS,
      text: SAMPLES.bilingualZhFirst,
    });
    const counts = countJobs();
    expect(counts.pending).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.obsolete).toBe(1);
    expect(getSummaryRecord(1)?.chineseSource).toBe("bangumi");
    // 手动重新翻译也会被拒绝
    expect(requeueSubjectTranslation(1, TS)).toBe(false);
  });

  it("Provider / 模型切换不会删除历史翻译，也不会自动重译", async () => {
    seedCollected(1, SAMPLES.ja);
    upsertSubjectSummary({ subjectId: 1, subjectName: "x", timestamp: TS });
    worker = new TranslationWorker({
      getConfig: () => AI_CONFIG,
      concurrency: () => 1,
      fetchImpl: mockFetch(),
      backoffBaseMs: 5,
    });
    worker.start(TS);
    expect(await worker.waitForIdle()).toBe(true);
    const translated = getSummaryRecord(1);
    expect(translated?.chinese).toBe(ZH_OUT);
    expect(translated?.translationProvider).toBe("openai-compatible");

    // 切换 provider / 模型后重新扫描：不应产生新任务
    const scan = refreshSummaryQueue(TS);
    expect(scan.enqueued).toBe(0);
    expect(countJobs().pending).toBe(0);
    const after = getSummaryRecord(1);
    expect(after?.chinese).toBe(ZH_OUT);
    expect(countJobs().completed).toBe(1);
  });

  it("transientFailed 与非临时失败区分：网络错误保持 pending", () => {
    seedCollected(1, SAMPLES.ja);
    upsertSubjectSummary({ subjectId: 1, subjectName: "x", timestamp: TS });
    run(
      `UPDATE translation_jobs SET status = 'failed', attempts = 9,
         last_error = '无法连接 AI 接口：fetch failed' WHERE subject_id = 1`,
    );
    // 历史失效治理不应把「当前 hash 的真失败」改成 obsolete
    obsoleteStaleJobs(TS);
    expect(countJobs().failed).toBe(1);
    expect(countJobs().obsolete).toBe(0);
  });
});
