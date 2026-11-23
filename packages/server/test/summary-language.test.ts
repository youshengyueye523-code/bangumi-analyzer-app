import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanTranslationOutput,
  detectSummaryLanguage,
  normalizeSummaryForHash,
  parseSummarySegments,
  translationStrategy,
  validateTranslationOutput,
} from "@bangumi-analyzer/shared";
import { enqueueTranslationJob, countJobs, resetInFlightJobs } from "../src/db/translationJobs.js";
import {
  getSummaryRecord,
  refreshSummaryQueue,
  requeueSubjectTranslation,
  upsertSubjectSummary,
} from "../src/db/summaries.js";
import { one, run } from "../src/db/index.js";
import { resetDatabase } from "./helpers.js";

/**
 * 简介语言识别与翻译输出校验。
 * 样本来自真实 Bangumi 数据（见 docs/test-report.md 的抽样统计）。
 */

const JA_SAMPLE =
  "「かぐや様は告らせたい」の赤坂アカ原作、「クズの本懐」の横槍メンゴ作画による「週刊ヤングジャンプ」連載の人気コミックをアニメ化した作品である。";
const ZH_SAMPLE =
  "2021年，随着超光速航行技术的实现，人类得以在太阳系范围内方便的自由移动，但是由于设计上的失误，这种技术引发了月球的爆炸。";
const ZH_WITH_JA_TITLE =
  "在电视动画系列准备播放最后动画结束的第十三话时，京都动画另外要求原本系列动画制作人员以及角色配音人员另外推出特别篇。";

describe("简介语言识别", () => {
  it("识别日文原文", () => {
    const stats = detectSummaryLanguage(JA_SAMPLE);
    expect(stats.language).toBe("ja");
    expect(stats.kanaCount).toBeGreaterThan(30);
  });

  it("识别官方中文简介（含繁体）", () => {
    expect(detectSummaryLanguage(ZH_SAMPLE).language).toBe("zh");
    expect(
      detectSummaryLanguage("全世界最多觀看次數的影片分享平台「NewTube」。三人組 NewTuber").language,
    ).toBe("zh");
  });

  it("中文简介里夹带少量日文专有名词时仍判为中文", () => {
    expect(detectSummaryLanguage(ZH_WITH_JA_TITLE).language).toBe("zh");
  });

  it("空简介与纯英文简介分别归为 empty / other", () => {
    expect(detectSummaryLanguage("").language).toBe("empty");
    expect(detectSummaryLanguage("   ").language).toBe("empty");
    expect(detectSummaryLanguage("A story about a girl and a robot in space.").language).toBe("en");
  });

  it("可识别的非中文语言都进入统一翻译队列，只有无法识别才跳过", () => {
    for (const language of ["ja", "en", "ko", "other"] as const) {
      expect(translationStrategy(language).translate, language).toBe(true);
    }
    expect(translationStrategy("zh").translate).toBe(false);
    expect(translationStrategy("zh").reason).toContain("官方中文");
    expect(translationStrategy("unknown").translate).toBe(false);
    expect(translationStrategy("unknown").reason).toContain("无法识别");
    expect(translationStrategy("empty").translate).toBe(false);
  });

  it("英文 / 韩文 / 其他文字系统能被识别为可翻译语言", () => {
    expect(
      detectSummaryLanguage(
        "A high school girl discovers a mysterious robot and together they travel across the galaxy.",
      ).language,
    ).toBe("en");
    expect(
      detectSummaryLanguage(
        "평범한 고등학생이 어느 날 갑자기 마법소녀가 되어 세계를 구하는 이야기입니다.",
      ).language,
    ).toBe("ko");
    expect(
      detectSummaryLanguage(
        "Обычная старшеклассница однажды встречает загадочного робота и отправляется в путешествие.",
      ).language,
    ).toBe("other");
  });
});

describe("原文指纹", () => {
  it("忽略换行与首尾空白的差异", () => {
    expect(normalizeSummaryForHash("  a\r\nb  ")).toBe(normalizeSummaryForHash("a\nb"));
  });
  it("内容变化时指纹改变", () => {
    expect(normalizeSummaryForHash("原文 A")).not.toBe(normalizeSummaryForHash("原文 B"));
  });
});

/**
 * 「日文原文 + [中文简介] + 官方中文」混合格式（真实数据里实际存在）。
 * 解析必须保守：只有标记整行独占、前面是日文正文、后面是中文正文才拆分。
 */
describe("混合双语简介解析", () => {
  const MIXED = `それは、彼女の運命を変えてしまうような出会い――
それは、新たなる魔法少女物語の始まり――

[中文简介]

出生良好家庭，亲朋好友团聚，时哭时笑，这是谁都拥有的日常生活。
市立见泷原中学的平凡初二女生鹿目圆，就是其中一位。`;

  it("识别标记并把日文与官方中文分别拆出", () => {
    const parsed = parseSummarySegments(MIXED);
    expect(parsed?.officialChinese).toBe(true);
    expect(parsed?.marker).toBe("[中文简介]");
    expect(parsed?.original).toContain("魔法少女物語");
    expect(parsed?.original).not.toContain("中文简介");
    expect(parsed?.chinese).toContain("鹿目圆");
    expect(parsed?.chinese).not.toContain("中文简介");
    // 分隔标记不能出现在任何一段正文里
    expect(parsed?.original).not.toContain("[");
    expect(parsed?.chinese).not.toContain("[");
  });

  it("其他标记变体同样可以识别", () => {
    for (const marker of ["【中文简介】", "（中文介绍）", "(中文概要)", "中文简介："]) {
      const text = `それは、新たなる魔法少女物語の始まり――\n彼女はまだ知らない。それは、彼女の運命を変えてしまうような出会い。\n${marker}\n出生良好家庭，亲朋好友团聚，时哭时笑，这是谁都拥有的日常生活。`;
      const parsed = parseSummarySegments(text);
      expect(parsed?.officialChinese, marker).toBe(true);
      expect(parsed?.chinese).toContain("日常生活");
    }
  });

  /** 变体 B：中文在前 + `[简介原文]` + 原文（真实数据里最多，43 条） */
  it("中文在前、`[简介原文]` 在后的结构同样能正确拆分", () => {
    const text = `《辉夜姬物语》是日本吉卜力工作室改编的动画电影，讲述竹取物语的故事。

[简介原文]

日本最古の物語といわれる「竹取物語」を題材に、高畑勲監督が手がける監督作。`;
    const parsed = parseSummarySegments(text);
    expect(parsed?.officialChinese).toBe(true);
    expect(parsed?.marker).toBe("[简介原文]");
    expect(parsed?.chinese).toContain("辉夜姬物语");
    expect(parsed?.original).toContain("竹取物語");
    // 标记不能出现在任何一段正文里
    expect(parsed?.chinese).not.toContain("[");
    expect(parsed?.original).not.toContain("[");
  });

  it("`[简介原文]` 的其他写法（[原文] / [日文原文] / 原文：）同样可以识别", () => {
    for (const marker of ["[原文]", "[日文原文]", "原文："]) {
      const text = `这是一个中文简介，讲述主角在校园里的日常故事。\n${marker}\n主人公はごく普通の高校生で、ある日を境に日常が変わっていく物語です。`;
      const parsed = parseSummarySegments(text);
      expect(parsed?.officialChinese, marker).toBe(true);
      expect(parsed?.original).toContain("高校生");
    }
  });

  it("结构不成立时不拆分（宁可不拆，也不误拆）", () => {
    // 标记前是不可识别的数字串、标记后是中文 → 不满足「原文可识别」条件
    const broken = "2024 / 01 / 01\n[中文简介]\n这是一个中文简介，讲述主角在校园里的日常故事。";
    const parsedBroken = parseSummarySegments(broken);
    expect(parsedBroken?.marker).toBe("");
    expect(parsedBroken?.original).toBe(broken);

    // 标记前后都是中文 → 不满足「原文是非中文」条件
    const bothChinese =
      "这是第一段中文简介，讲述主角的日常。\n[简介原文]\n这是第二段中文内容，同样不是外文。";
    const parsedBoth = parseSummarySegments(bothChinese);
    expect(parsedBoth?.marker).toBe("");
  });

  it("中文简介里出现日语专有名词与「中文简介」字样时不会被误判", () => {
    const text = "本作根据「中文简介」栏目整理而成。讲述的就是一群喜爱动画、漫画的高中女生们的日常生活。其中主角泉こなた更是为了喜欢的东西会不惜一切的女孩子，整天出入OTAKU们的圣地秋叶原。";
    const parsed = parseSummarySegments(text);
    expect(parsed?.marker).toBe("");
    expect(parsed?.chinese).toBe(text);
    expect(parsed?.original).toBe("");
  });

  it("纯中文与纯日文简介不会被误判为混合格式", () => {
    expect(parseSummarySegments(ZH_SAMPLE)?.officialChinese).toBe(true);
    expect(parseSummarySegments(ZH_SAMPLE)?.marker).toBe("");
    expect(parseSummarySegments(JA_SAMPLE)?.officialChinese).toBe(false);
    expect(parseSummarySegments(JA_SAMPLE)?.original).toBe(JA_SAMPLE);
  });
});

describe("翻译输出清洗与校验", () => {
  it("去掉「以下是翻译」等前后缀与代码块", () => {
    expect(cleanTranslationOutput("以下是翻译：\n这是一个测试简介。")).toBe("这是一个测试简介。");
    expect(cleanTranslationOutput("```\n这是一个测试简介。\n```")).toBe("这是一个测试简介。");
    expect(cleanTranslationOutput("译文：这是一个测试简介。")).toBe("这是一个测试简介。");
  });

  it("接受正常的中文译文，拒绝日文 / 英文 / 中文原文", () => {
    expect(
      validateTranslationOutput(
        "这是一个关于少女与机器人在太空中冒险的故事，两人一起穿越星海寻找回家的路。",
        JA_SAMPLE,
      ).ok,
    ).toBe(true);
    expect(validateTranslationOutput(JA_SAMPLE, JA_SAMPLE).ok).toBe(false);
    expect(validateTranslationOutput("This is a story about a girl.", JA_SAMPLE).ok).toBe(false);
    expect(validateTranslationOutput("这是一段很长的翻译结果样本内容，用来验证。", ZH_SAMPLE).ok).toBe(false);
  });
});

/* ---------------------------------------------------------- 数据层 / 队列 */

function seedSubject(id: number, summary: string, collected = true): void {
  const ts = "2026-01-01T00:00:00.000Z";
  run(
    `INSERT INTO subjects (id, name, name_cn, summary, created_at, updated_at)
     VALUES (:id, :name, :nameCn, :summary, :ts, :ts)`,
    { id, name: `Subject ${id}`, nameCn: `条目 ${id}`, summary, ts },
  );
  if (collected) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, vol_status,
         comment, tags, private, updated_at, first_seen_at, synced_at)
       VALUES (:id, 2, 2, 0, 0, 0, '', '[]', 0, :ts, :ts, :ts)`,
      { id, ts },
    );
  }
}

const TS = "2026-01-02T00:00:00.000Z";

describe("简介入库与入队", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("日文简介 → 保存原文并创建翻译任务", () => {
    seedSubject(1, JA_SAMPLE);
    const result = upsertSubjectSummary({
      subjectId: 1,
      text: JA_SAMPLE,
      subjectName: "测试条目",
      timestamp: TS,
    });
    expect(result.language).toBe("ja");
    expect(result.enqueued).toBe(true);

    const record = getSummaryRecord(1);
    expect(record?.language).toBe("ja");
    expect(record?.original).toBe(JA_SAMPLE);
    expect(record?.status).toBe("pending");
    expect(record?.chinese).toBe("");
    expect(countJobs().pending).toBe(1);
    // 原文列（一手资料）必须原样保存
    expect(one<{ summary: string }>("SELECT summary FROM subjects WHERE id = 1")?.summary).toBe(JA_SAMPLE);
  });

  it("官方中文简介 → 不作为翻译任务，界面直接可读", () => {
    seedSubject(2, ZH_SAMPLE);
    const result = upsertSubjectSummary({
      subjectId: 2,
      text: ZH_SAMPLE,
      subjectName: "中文条目",
      timestamp: TS,
    });
    expect(result.language).toBe("zh");
    expect(result.enqueued).toBe(false);
    expect(countJobs().pending).toBe(0);

    const record = getSummaryRecord(2);
    expect(record?.chinese).toBe(ZH_SAMPLE);
    expect(record?.chineseSource).toBe("bangumi");
    expect(record?.translatable).toBe(false);
  });

  it("没有简介 → 不创建任务，也不写假内容", () => {
    seedSubject(3, "");
    const result = upsertSubjectSummary({
      subjectId: 3,
      text: "",
      subjectName: "空简介",
      timestamp: TS,
    });
    expect(result.language).toBe("empty");
    expect(result.enqueued).toBe(false);
    expect(countJobs().pending).toBe(0);
    expect(getSummaryRecord(3)?.chinese).toBe("");
  });

  it("重复同步同一原文 → 不重复创建任务（不重复消耗 token）", () => {
    seedSubject(4, JA_SAMPLE);
    upsertSubjectSummary({ subjectId: 4, text: JA_SAMPLE, subjectName: "x", timestamp: TS });
    const again = upsertSubjectSummary({
      subjectId: 4,
      text: JA_SAMPLE,
      subjectName: "x",
      timestamp: TS,
    });
    expect(again.enqueued).toBe(false);
    expect(again.changed).toBe(false);
    expect(countJobs().pending).toBe(1);
  });

  it("原文变化 → 新任务入队，旧翻译保留并标记过期", () => {
    seedSubject(5, JA_SAMPLE);
    upsertSubjectSummary({ subjectId: 5, text: JA_SAMPLE, subjectName: "x", timestamp: TS });
    // 模拟第一次翻译完成
    const hash = getSummaryRecord(5)!.sourceHash;
    run(
      `UPDATE subjects SET summary_zh_ai = '旧的中文翻译内容', summary_zh_ai_hash = :hash,
         summary_zh_ai_status = 'completed' WHERE id = 5`,
      { hash },
    );
    run(`UPDATE translation_jobs SET status = 'completed' WHERE subject_id = 5`);

    const updated = `${JA_SAMPLE} 追加的新段落说明。`;
    const result = upsertSubjectSummary({
      subjectId: 5,
      text: updated,
      subjectName: "x",
      timestamp: TS,
    });
    expect(result.changed).toBe(true);
    expect(result.enqueued).toBe(true);
    expect(result.previousTranslationKept).toBe(true);

    const record = getSummaryRecord(5);
    // 旧翻译仍然保留并标记过期，绝不因为重新翻译而清空
    expect(record?.chinese).toBe("旧的中文翻译内容");
    expect(record?.stale).toBe(true);
    expect(record?.status).toBe("pending");
    expect(countJobs().pending).toBe(1);
    // 旧任务（旧 hash）不再计入当前已完成，而是历史失效
    expect(countJobs().completed).toBe(0);
    expect(countJobs().obsolete).toBe(1);
  });

  it("非收藏条目不会入队", () => {
    seedSubject(6, JA_SAMPLE, false);
    const result = upsertSubjectSummary({
      subjectId: 6,
      text: JA_SAMPLE,
      subjectName: "x",
      timestamp: TS,
    });
    expect(result.enqueued).toBe(false);
    expect(countJobs().pending).toBe(0);
  });

  it("历史数据回填：只有可翻译的外文才补队，幂等", () => {
    seedSubject(7, JA_SAMPLE);
    seedSubject(8, ZH_SAMPLE);
    seedSubject(9, "");
    const first = refreshSummaryQueue(TS);
    expect(first.translatable).toBe(1);
    expect(first.chinese).toBe(1);
    expect(first.enqueued).toBe(1);

    const second = refreshSummaryQueue(TS);
    expect(second.enqueued).toBe(0);
    expect(countJobs().pending).toBe(1);
  });

  it("双语简介（日文在前）：拆成原文 + 官方中文，且不创建翻译任务", () => {
    const mixed = `それは、新たなる魔法少女物語の始まり――\n彼女はまだ知らない。\n\n[中文简介]\n\n出生良好家庭，亲朋好友团聚，时哭时笑，这是谁都拥有的日常生活。`;
    seedSubject(20, mixed);
    const result = upsertSubjectSummary({
      subjectId: 20,
      subjectName: "魔法少女まどか☆マギカ",
      timestamp: TS,
    });
    expect(result.bilingual).toBe(true);
    expect(result.enqueued).toBe(false);
    expect(countJobs().pending).toBe(0);

    const record = getSummaryRecord(20);
    expect(record?.original).toContain("魔法少女物語");
    expect(record?.officialChinese).toContain("日常生活");
    expect(record?.chineseSource).toBe("bangumi");
    expect(record?.chinese).toBe(record?.officialChinese);
    expect(record?.translatable).toBe(false);
    // 原始 summary 必须原样保留（一手数据不可破坏）
    expect(one<{ summary: string }>("SELECT summary FROM subjects WHERE id = 20")?.summary).toBe(mixed);
    // 分隔标记不能出现在正文列里
    expect(record?.original).not.toContain("中文简介");
    expect(record?.officialChinese).not.toContain("中文简介");
  });

  it("混合双语条目不会重复显示同一份中文（AI 列保持为空）", () => {
    const mixed = `それは、新たなる魔法少女物語の始まり――\n彼女はまだ知らない。\n\n[中文简介]\n\n出生良好家庭，亲朋好友团聚，时哭时笑，这是谁都拥有的日常生活。`;
    seedSubject(21, mixed);
    upsertSubjectSummary({ subjectId: 21, subjectName: "x", timestamp: TS });
    // 官方中文存在时，手动「重新翻译」应当被拒绝
    expect(requeueSubjectTranslation(21, TS)).toBe(false);
    expect(getSummaryRecord(21)?.translation).toBe("");
    expect(countJobs().pending).toBe(0);
  });

  it("中断恢复：processing 任务在重启后回到 pending", () => {
    seedSubject(10, JA_SAMPLE);
    upsertSubjectSummary({ subjectId: 10, text: JA_SAMPLE, subjectName: "x", timestamp: TS });
    run(`UPDATE translation_jobs SET status = 'processing' WHERE subject_id = 10`);
    expect(countJobs().processing).toBe(1);

    const reset = resetInFlightJobs(TS);
    expect(reset).toBe(1);
    expect(countJobs().pending).toBe(1);
    expect(countJobs().processing).toBe(0);
  });

  it("同一作品 + 同一 hash 只允许一行任务（唯一索引兜底）", () => {
    seedSubject(11, JA_SAMPLE);
    const first = enqueueTranslationJob({ subjectId: 11, sourceHash: "hash-a", timestamp: TS });
    const second = enqueueTranslationJob({ subjectId: 11, sourceHash: "hash-a", timestamp: TS });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
  });
});
