/**
 * 「我的画像」数据集构建器。
 *
 * 职责：把收藏数据加工成**结构化证据**（统计 + 确定性结论 + 样本），
 * 供两处使用：
 *   1) 前端直接展示（不依赖 AI 也能完整阅读）；
 *   2) 作为 AI 总结的唯一输入（AI 看不到数据库，只能看到这里算好的数字）。
 */

import {
  COLLECTION_TYPE_LABEL,
  type ProfileAvoidance,
  type ProfileBreadth,
  type ProfileClaim,
  type ProfileDataset,
  type ProfileDimensionStat,
  type ProfileLengthBucket,
  type ProfilePeriod,
  type ProfileSeriesStats,
  type ProfileTagPair,
  type ProfileWorkSample,
} from '@bangumi-analyzer/shared';
import { all, one, dataVersion } from '../db/index.js';
import {
  currentVisibility,
  seriesVisibilityClause,
  subjectVisibilityClause,
  type Visibility,
} from '../db/visibility.js';
import { nowIso, round } from '../util.js';
import { EPISODE_EXPRESSION, EP_STATUS_EXPRESSION, WATCHED_EXPRESSION, jsonArrayExpression } from './expressions.js';

const HIGH_RATE = 8;
const LOW_RATE = 5;
const SAMPLE_LIMIT = 40;
const TAG_LIMIT = 80;
const PAIR_MIN_COUNT = 5;
const PAIR_MIN_LIFT = 1.5;
/** 参与「审美模板」分析的标签至少要覆盖这么多比例的作品 */
const PAIR_MIN_TAG_SHARE = 0.03;
/** 近义标签的 Jaccard 相似度上限（超过即视为同一概念的重复标签） */
const PAIR_MAX_JACCARD = 0.7;
/** 出现比例高于该值的标签几乎没有区分度（例如「日本」「TV」） */
const UNIVERSAL_TAG_SHARE = 0.5;

/**
 * 无区分度的标签：与个人审美无关的元数据标签。
 * 如果不排除它们，「高分作品里 TV + 日本 组合最多」这种废话就会成为「审美模板」。
 */
const UNINFORMATIVE_TAGS = new Set([
  '日本',
  '中国',
  '欧美',
  'TV',
  'WEB',
  'OVA',
  'OAD',
  'ONA',
  '剧场版',
  '劇場版',
  '电影',
  '动画',
  '动漫',
  '漫画改',
  '漫改',
  '原创',
  '小说改',
  '轻小说改',
  '游戏改',
  '音乐',
  '新番',
  '追番',
  '连载',
  '完结',
  '看过',
  '在看',
  '想看',
  '搁置',
  '抛弃',
]);

/** 判断一个标签是否携带「题材偏好」信息。 */
export function isInformativeTag(name: string): boolean {
  const tag = name.trim();
  if (!tag) return false;
  if (UNINFORMATIVE_TAGS.has(tag)) return false;
  if (/^\d+$/.test(tag)) return false; // 纯数字（年份）
  if (/^\d{1,2}\s*月$/.test(tag)) return false; // 月份
  if (/^\d{4}\s*年/.test(tag)) return false; // 年份 / 年月
  if (/^\d{4}\s*年代$/.test(tag)) return false; // 年代
  if (/^\d{4}\s*年\d{1,2}\s*月$/.test(tag)) return false;
  if (/^\d{4}\s*(春|夏|秋|冬)$/.test(tag)) return false; // 2026春
  if (/^\d{4}\s*s$/i.test(tag)) return false; // 2020s
  if (/^第[一二三四五六七八九十0-9]{1,3}\s*(季|期|部|章|话|話)$/.test(tag)) return false; // 第二季
  if (/^\d+\s*集$/.test(tag)) return false; // 12集
  if (/^(续作|续集|新作|重制|重置|剧场版新作)$/.test(tag)) return false;
  if (/^[A-Za-z]{2,6}\d*$/.test(tag)) return false; // TV/OVA/WEB 之类的形态缩写
  return true;
}

/**
 * 非题材标签的排除集合：制作人员 / 公司 / 导演名字，以及作品自身的标题。
 *
 * 这些名字也常常被当作标签（例如「早见沙织」「KINEMACITRUS」「进击的巨人」），
 * 但它们描述的是「谁做的 / 哪部作品」，不是审美结构，参与偏好分析会产生噪声。
 */
function loadNonThematicNames(): Set<string> {
  const names = new Set<string>();
  for (const row of all<{ name: string }>('SELECT DISTINCT name FROM subject_staff')) {
    const name = row.name.trim();
    if (name) names.add(normalizeForMatch(name));
  }
  for (const row of all<{ name: string; name_cn: string }>('SELECT name, name_cn FROM subjects')) {
    if (row.name.trim()) names.add(normalizeForMatch(row.name.trim()));
    if (row.name_cn.trim()) names.add(normalizeForMatch(row.name_cn.trim()));
  }
  for (const row of all<{ value: string }>(
    `SELECT je.value AS value FROM subjects s, json_each(${jsonArrayExpression('s.studios')}) je WHERE je.type = 'text'
     UNION SELECT je.value AS value FROM subjects s, json_each(${jsonArrayExpression('s.directors')}) je WHERE je.type = 'text'`,
  )) {
    const name = row.value.trim();
    if (name) names.add(normalizeForMatch(name));
  }
  return names;
}

export type TagFilter = (name: string) => boolean;

function createThematicTagFilter(staffNames: Set<string>): TagFilter {
  return (name: string) => {
    const tag = name.trim();
    if (!isInformativeTag(tag)) return false;
    if (staffNames.has(normalizeForMatch(tag))) return false;
    // 纯拉丁字母 / 数字的标签基本是公司、厂牌或品牌，不是题材
    if (/^[A-Za-z0-9_\s.'\-&]+$/.test(tag)) return false;
    return true;
  };
}

/** Bangumi 由维基维护的「类型标签」词表：用于提取真正描述题材的组合。 */
function loadMetaTagVocabulary(): Set<string> {
  const rows = all<{ value: string }>(
    `SELECT DISTINCT je.value AS value FROM subjects s, json_each(${jsonArrayExpression('s.meta_tags')}) je WHERE je.type = 'text'`,
  );
  return new Set(rows.map((row) => row.value.trim()).filter(Boolean));
}

/**
 * 名称归一化：用于「标签名是否等于某个人名 / 作品名」的比较。
 * Bangumi 的人员名常用日文写法（澤野弘之），而标签常用简体（泽野弘之），
 * 因此这里做 NFKC + 去符号 + 常见字形映射，避免因为字形差异漏判。
 */
const GLYPH_VARIANTS: Record<string, string> = {
  澤: '泽',
  輝: '辉',
  學: '学',
  國: '国',
  廣: '广',
  島: '岛',
  瀬: '濑',
  邊: '边',
  龍: '龙',
  優: '优',
  葉: '叶',
  樹: '树',
  鳴: '鸣',
  藤: '藤',
  織: '织',
  場: '场',
  會: '会',
  檢: '检',
  傳: '传',
  專: '专',
  門: '门',
  貴: '贵',
  齊: '齐',
  實: '实',
};

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\u3000·・.,，。:：;；!！?？'"“”‘’()（）[\]【】<>《》\-_/\\|+&～~]/g, '')
    .replace(/[澤輝學國廣島瀬邊龍優葉樹鳴織場會檢傳專門貴齊實]/g, (char) => GLYPH_VARIANTS[char] ?? char)
    .toLowerCase();
}

interface TagRow {
  name: string;
  count: number;
  highCount: number;
  lowCount: number;
  averageRate: number | null;
}

function dimensionStat(
  name: string,
  count: number,
  total: number,
  highTotal: number,
  highCount: number,
  averageRate: number | null,
): ProfileDimensionStat {
  const share = total > 0 ? count / total : 0;
  const highShare = highTotal > 0 ? highCount / highTotal : null;
  return {
    name,
    count,
    share: Number(share.toFixed(4)),
    averageRate: round(averageRate),
    highShare: highShare === null ? null : Number(highShare.toFixed(4)),
    lift:
      highShare !== null && share > 0 ? Number((highShare / share).toFixed(2)) : null,
  };
}

/** 标签维度：整体出现次数 + 高分组/低分组表现。口径与作品样本一致（v1.8）。 */
function tagStats(visibility: Visibility): TagRow[] {
  const rows = all<{
    name: string;
    count: number;
    high_count: number;
    low_count: number;
    average_rate: number | null;
  }>(
    `SELECT je.value AS name,
            COUNT(*) AS count,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= ${HIGH_RATE} THEN 1 ELSE 0 END) AS high_count,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 AND effective_personal_rate(c.type,c.rate) <= ${LOW_RATE} THEN 1 ELSE 0 END) AS low_count,
            AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS average_rate
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.tag_names')}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s', visibility)}
     GROUP BY je.value
     ORDER BY count DESC, je.value ASC`,
  );
  return rows.map((row) => ({
    name: row.name,
    count: Number(row.count),
    highCount: Number(row.high_count ?? 0),
    lowCount: Number(row.low_count ?? 0),
    averageRate: row.average_rate === null ? null : Number(row.average_rate),
  }));
}

function tagDimensionStats(rows: TagRow[], total: number, highTotal: number) {
  return rows
    .slice(0, TAG_LIMIT)
    .map((row) =>
      dimensionStat(row.name, row.count, total, highTotal, row.highCount, row.averageRate),
    );
}

/** 普通列维度（放送形态 / 季度 / 原作类型）统计。 */
function columnDimensionStats(
  expression: string,
  options: { visibility: Visibility; where?: string; limit?: number },
): ProfileDimensionStat[] {
  const conditions = [subjectVisibilityClause('s', options.visibility)];
  if (options.where) conditions.push(options.where);
  const rows = all<{
    name: string | null;
    count: number;
    high_count: number;
    average_rate: number | null;
  }>(
    `SELECT ${expression} AS name,
            COUNT(*) AS count,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= ${HIGH_RATE} THEN 1 ELSE 0 END) AS high_count,
            AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS average_rate
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE ${conditions.join(' AND ')}
     /* 必须按表达式分组：GROUP BY name 会被解析为 subjects.name（输入列优先于别名） */
     GROUP BY ${expression}
     ORDER BY count DESC`,
  );
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
  const highTotal = rows.reduce((sum, row) => sum + Number(row.high_count ?? 0), 0);
  return rows
    .filter((row) => row.name !== null && row.name !== '')
    .slice(0, options.limit ?? 40)
    .map((row) =>
      dimensionStat(
        String(row.name),
        Number(row.count),
        total,
        highTotal,
        Number(row.high_count ?? 0),
        row.average_rate === null ? null : Number(row.average_rate),
      ),
    );
}

/** JSON 数组列维度（制作公司 / 导演 / 原作）统计。 */
function jsonDimensionStats(
  column: 'studios' | 'directors' | 'originals',
  visibility: Visibility,
): ProfileDimensionStat[] {
  const rows = all<{
    name: string;
    count: number;
    high_count: number;
    average_rate: number | null;
  }>(
    `SELECT je.value AS name,
            COUNT(*) AS count,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= ${HIGH_RATE} THEN 1 ELSE 0 END) AS high_count,
            AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS average_rate
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression(`s.${column}`)}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s', visibility)}
     GROUP BY je.value
     ORDER BY count DESC
     LIMIT 200`,
  );
  const total = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE ${subjectVisibilityClause('s', visibility)}`,
  );
  const highTotal = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE effective_personal_rate(c.type,c.rate) >= ${HIGH_RATE} AND ${subjectVisibilityClause('s', visibility)}`,
  );
  return rows.map((row) =>
    dimensionStat(
      row.name,
      Number(row.count),
      Number(total?.n ?? 0),
      Number(highTotal?.n ?? 0),
      Number(row.high_count ?? 0),
      row.average_rate === null ? null : Number(row.average_rate),
    ),
  );
}

interface WorkRow {
  id: number;
  title: string;
  rate: number;
  score: number | null;
  type: number;
  epStatus: number;
  year: number | null;
  format: string;
  episodes: number;
  watchedEpisodes: number;
  tags: string[];
  studios: string[];
  directors: string[];
  series_key: string | null;
  updated_at: string | null;
}

function loadWorks(visibility: Visibility): WorkRow[] {
  const rows = all<{
    id: number;
    title: string;
    rate: number;
    score: number | null;
    type: number;
    ep_status: number;
    year: number | null;
    format: string;
    episodes: number;
    watched_episodes: number;
    tag_names: string;
    studios: string;
    directors: string;
    series_key: string | null;
    updated_at: string | null;
  }>(
    `SELECT s.id,
            COALESCE(NULLIF(s.name_cn, ''), s.name) AS title,
            effective_personal_rate(c.type,c.rate) AS rate, canonical_score(s.score) AS score, c.type AS type, canonical_positive_integer(s.year) AS year,
            ${EP_STATUS_EXPRESSION} AS ep_status,
            s.format AS format,
            ${EPISODE_EXPRESSION} AS episodes,
            CASE WHEN c.type IN (2,3,4,5) THEN ${WATCHED_EXPRESSION} ELSE 0 END AS watched_episodes,
            s.tag_names AS tag_names, s.studios AS studios, s.directors AS directors,
            s.series_key AS series_key, c.updated_at AS updated_at
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE ${subjectVisibilityClause('s', visibility)}`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    rate: Number(row.rate ?? 0),
    score: row.score === null ? null : Number(row.score),
    type: Number(row.type),
    epStatus: Number(row.ep_status ?? 0),
    year: row.year === null ? null : Number(row.year),
    format: row.format,
    episodes: Number(row.episodes ?? 0),
    watchedEpisodes: Number(row.watched_episodes ?? 0),
    tags: safeArray(row.tag_names),
    studios: safeArray(row.studios),
    directors: safeArray(row.directors),
    series_key: row.series_key,
    updated_at: row.updated_at,
  }));
}

function safeArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === 'string'))] : [];
  } catch {
    return [];
  }
}

function toSample(work: WorkRow): ProfileWorkSample {
  return {
    id: work.id,
    title: work.title,
    myRate: work.rate,
    bgmScore: work.score,
    delta: work.rate > 0 && work.score && work.score > 0 ? Number((work.rate - work.score).toFixed(2)) : null,
    status: COLLECTION_TYPE_LABEL[work.type as 1] ?? String(work.type),
    year: work.year,
    format: work.format,
    episodes: work.episodes,
    tags: work.tags.slice(0, 12),
    studios: work.studios.slice(0, 3),
    directors: work.directors.slice(0, 3),
    series: work.series_key,
  };
}

/**
 * 高分作品中的标签共现（用于发现「审美模板」）。
 *
 * 排序依据是**区分度（lift）**而不是出现次数：
 * 出现次数最高的组合通常只是「TV + 日本」这类人人都有、毫无信息量的标签，
 * 只有明显高于独立假设的组合才说明「这类组合是你个人的偏好」。
 */
function buildTagPairs(works: WorkRow[], isThematic: TagFilter): ProfileTagPair[] {
  const highRated = works.filter((work) => work.rate >= HIGH_RATE);
  if (highRated.length < PAIR_MIN_COUNT) return [];
  const minTagWorks = Math.max(8, Math.round(highRated.length * PAIR_MIN_TAG_SHARE));

  const tagWorks = new Map<string, Set<number>>();
  const tagFrequency = new Map<string, number>();
  const pairCount = new Map<string, number>();

  for (const work of highRated) {
    const tags = [...new Set(work.tags)].slice(0, 20);
    for (const tag of tags) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
      const set = tagWorks.get(tag) ?? new Set<number>();
      set.add(work.id);
      tagWorks.set(tag, set);
    }
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const a = tags[i]!;
        const b = tags[j]!;
        if (!isThematic(a) || !isThematic(b)) continue;
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  const informativePair = (a: string, b: string): boolean => {
    const setA = tagWorks.get(a);
    const setB = tagWorks.get(b);
    if (!setA || !setB) return false;
    // 两个标签都要有一定的使用量，避免把偶然共现的冷门标签当成「模板」
    if (setA.size < minTagWorks || setB.size < minTagWorks) return false;
    // 近义 / 包含关系（例如「漫画改」与「漫改」）不算组合
    let overlap = 0;
    for (const id of setA) if (setB.has(id)) overlap += 1;
    const union = setA.size + setB.size - overlap;
    const jaccard = union > 0 ? overlap / union : 0;
    if (jaccard >= PAIR_MAX_JACCARD) return false;
    // 近半数作品都有的标签没有区分度
    if (setA.size / highRated.length >= UNIVERSAL_TAG_SHARE) return false;
    if (setB.size / highRated.length >= UNIVERSAL_TAG_SHARE) return false;
    return true;
  };

  const pairs: ProfileTagPair[] = [];
  for (const [key, count] of pairCount) {
    if (count < PAIR_MIN_COUNT) continue;
    const [a, b] = key.split('\u0000') as [string, string];
    if (!informativePair(a, b)) continue;
    const expected =
      ((tagFrequency.get(a) ?? 0) * (tagFrequency.get(b) ?? 0)) / highRated.length;
    const lift = expected > 0 ? Number((count / expected).toFixed(2)) : 0;
    if (lift < PAIR_MIN_LIFT) continue;
    pairs.push({
      a,
      b,
      count,
      share: Number((count / highRated.length).toFixed(4)),
      expected: Number(expected.toFixed(2)),
      lift,
    });
  }

  // 先比区分度，再比样本量
  return pairs.sort((x, y) => y.lift - x.lift || y.count - x.count).slice(0, 20);
}

const LENGTH_BUCKETS: Array<{ bucket: string; min: number; max: number | null }> = [
  { bucket: '单集 / 短片', min: 0, max: 1 },
  { bucket: '2–6 集', min: 2, max: 6 },
  { bucket: '7–13 集', min: 7, max: 13 },
  { bucket: '14–26 集', min: 14, max: 26 },
  { bucket: '27–52 集', min: 27, max: 52 },
  { bucket: '52 集以上', min: 53, max: null },
];

function buildLengthBuckets(works: WorkRow[]): ProfileLengthBucket[] {
  const withEpisodes = works.filter((work) => work.episodes > 0);
  const highTotal = withEpisodes.filter((work) => work.rate >= HIGH_RATE).length;
  return LENGTH_BUCKETS.map((bucket) => {
    const items = withEpisodes.filter(
      (work) =>
        work.episodes >= bucket.min && (bucket.max === null || work.episodes <= bucket.max),
    );
    const rated = items.filter((work) => work.rate > 0);
    const high = items.filter((work) => work.rate >= HIGH_RATE).length;
    return {
      bucket: bucket.bucket,
      minEpisodes: bucket.min,
      maxEpisodes: bucket.max,
      count: items.length,
      averageRate:
        rated.length > 0
          ? round(rated.reduce((sum, work) => sum + work.rate, 0) / rated.length)
          : null,
      highShare: highTotal > 0 ? Number((high / highTotal).toFixed(4)) : null,
    };
  }).filter((bucket) => bucket.count > 0);
}

function seriesStats(visibility: Visibility): ProfileSeriesStats {
  const visible = subjectVisibilityClause('s', visibility);
  const grouped = all<{ id: number; rate: number }>(
    `SELECT c.subject_id AS id, effective_personal_rate(c.type,c.rate) AS rate
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     JOIN series_entities e ON e.key = s.series_key
     WHERE e.member_count >= 2 AND e.state <> 'stale' AND ${visible}`,
  );
  const standalone = all<{ id: number; rate: number }>(
    `SELECT c.subject_id AS id, effective_personal_rate(c.type,c.rate) AS rate
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE (s.series_key IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM series_entities e
          WHERE e.key = s.series_key AND e.member_count >= 2 AND e.state <> 'stale'
        ))
        AND ${visible}`,
  );
  const groupCount = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM series_entities e
     WHERE e.member_count >= 2 AND e.state <> 'stale'
       AND ${seriesVisibilityClause('e', visibility)}`,
  );
  const ratedAverage = (rows: Array<{ rate: number }>) => {
    const rated = rows.filter((row) => Number(row.rate) > 0).map((row) => Number(row.rate));
    return rated.length > 0 ? round(rated.reduce((sum, value) => sum + value, 0) / rated.length) : null;
  };
  const groups = Number(groupCount?.n ?? 0);
  return {
    groupedWorks: grouped.length,
    standaloneWorks: standalone.length,
    groupCount: groups,
    averageRateGrouped: ratedAverage(grouped),
    averageRateStandalone: ratedAverage(standalone),
    averageGroupSize: groups > 0 ? Number((grouped.length / groups).toFixed(2)) : null,
  };
}

/** Analysis-only Real projection; primary collected members, deduped within each eligible family. */
export function profileFranchiseStats() {
  const rows = all<{ title: string; collected: number; rated: number; averageRate: number | null }>(
    `WITH members AS (
       SELECT DISTINCT f.id, f.title, c.subject_id, effective_personal_rate(c.type,c.rate) AS rate
       FROM franchise_entities f
       JOIN franchise_series fs ON fs.franchise_id=f.id AND fs.state <> 'conflict'
       JOIN series_entities e ON e.id=fs.series_id AND e.state NOT IN ('stale','rejected')
       JOIN series_entity_members m ON m.series_id=e.id AND m.role='primary'
       JOIN collections c ON c.subject_id=m.subject_id
       WHERE f.state NOT IN ('stale','rejected')
     )
     SELECT title, COUNT(*) AS collected, COUNT(NULLIF(rate,0)) AS rated,
            ROUND(AVG(NULLIF(rate,0)),2) AS averageRate
     FROM members GROUP BY id, title ORDER BY collected DESC, id`,
  );
  return { groupCount: rows.length, largestGroups: rows.slice(0, 10) };
}

interface AvoidanceCandidate {
  name: string;
  dimension: string;
  works: WorkRow[];
}

function statusCountsOf(works: WorkRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const work of works) {
    const key = String(work.type);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildAvoidance(
  works: WorkRow[],
  tags: TagRow[],
  overallAverageRate: number | null,
  isThematic: TagFilter,
  visibility: Visibility,
): ProfileAvoidance[] {
  const candidates: AvoidanceCandidate[] = [];
  const minTagWorks = Math.max(6, Math.round(works.length * 0.025));

  // 标签维度：接触 ≥4 部才纳入（避免用 1 部作品下结论）
  for (const tag of tags) {
    // 只考虑携带题材信息的标签，且需要一定的接触量
    if (!isThematic(tag.name)) continue;
    if (tag.count < minTagWorks) continue;
    const tagWorks = works.filter((work) => work.tags.includes(tag.name));
    if (tagWorks.length >= minTagWorks) {
      candidates.push({ name: tag.name, dimension: '标签', works: tagWorks });
    }
  }

  const byFormat = new Map<string, WorkRow[]>();
  const byOriginal = new Map<string, WorkRow[]>();
  for (const work of works) {
    byFormat.set(work.format, [...(byFormat.get(work.format) ?? []), work]);
  }
  for (const [name, items] of byFormat) {
    if (name && items.length >= 5) candidates.push({ name, dimension: '放送形态', works: items });
  }

  const rows = all<{ name: string; subject_id: number }>(
    `SELECT je.value AS name, s.id AS subject_id
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.originals')}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s', visibility)}`,
  );
  for (const row of rows) {
    const list = byOriginal.get(row.name) ?? [];
    const work = works.find((item) => item.id === Number(row.subject_id));
    if (work) list.push(work);
    byOriginal.set(row.name, list);
  }
  for (const [name, items] of byOriginal) {
    // infobox 的「原作」有时写的是作者 / 出版社（例如「奈須きのこ」），
    // 这里只保留明确表示原作类型的取值。
    const isOriginalType = /(漫画|小说|游戏|原创|动画|轻小说|绘本|特摄|真人|改编|改$)/.test(name);
    const isShortLabel = name.length <= 10 && !/[（(／/]/.test(name);
    if (isOriginalType && isShortLabel && items.length >= 5) {
      candidates.push({ name, dimension: '原作类型', works: items });
    }
  }

  const results: ProfileAvoidance[] = [];
  for (const candidate of candidates) {
    const items = candidate.works;
    const rated = items.filter((work) => work.rate > 0);
    const averageRate =
      rated.length > 0 ? Number((rated.reduce((sum, work) => sum + work.rate, 0) / rated.length).toFixed(2)) : null;
    const gap =
      averageRate !== null && overallAverageRate !== null
        ? Number((averageRate - overallAverageRate).toFixed(2))
        : null;
    const statusCounts = statusCountsOf(items);
    const abandoned = (statusCounts['4'] ?? 0) + (statusCounts['5'] ?? 0);
    const wishOnly = statusCounts['1'] ?? 0;
    const unratedCount = items.length - rated.length;

    let pattern: ProfileAvoidance['pattern'] | null = null;
    let note = '';
    if (gap !== null && gap <= -0.6 && rated.length >= 5) {
      pattern = 'low-rated';
      note = `接触 ${items.length} 部、其中 ${rated.length} 部已评分，平均比你的整体平均分低 ${Math.abs(gap).toFixed(2)} 分`;
    } else if (abandoned >= 3 && abandoned / items.length >= 0.25) {
      pattern = 'abandoned';
      note = `接触 ${items.length} 部，其中 ${abandoned} 部被搁置或抛弃（${Math.round((abandoned / items.length) * 100)}%）`;
    } else if (wishOnly >= 5 && wishOnly / items.length >= 0.5) {
      pattern = 'not-started';
      note = `收藏了 ${items.length} 部，其中 ${wishOnly} 部一直停留在「想看」`;
    } else if (unratedCount / items.length >= 0.7 && items.length >= 6) {
      pattern = 'mostly-unrated';
      note = `${items.length} 部中有 ${unratedCount} 部没有评分，说明你很少回味这一类作品`;
    }
    if (!pattern) continue;

    results.push({
      name: candidate.name,
      dimension: candidate.dimension,
      count: items.length,
      averageRate,
      overallAverageRate,
      gap,
      statusCounts,
      abandoned,
      wishOnly,
      unratedCount,
      pattern,
      note,
    });
  }

  const severity: Record<ProfileAvoidance['pattern'], number> = {
    'low-rated': 0,
    abandoned: 1,
    'not-started': 2,
    'mostly-unrated': 3,
  };

  return results
    .sort(
      (a, b) =>
        severity[a.pattern] - severity[b.pattern] ||
        (a.gap ?? 0) - (b.gap ?? 0) ||
        b.count - a.count,
    )
    .slice(0, 10);
}

function shannonEntropy(counts: number[]): number | null {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(2));
}

/** 按「最后更新年份」分段的兴趣快照（近似，界面会标注）。 */
function buildPeriods(works: WorkRow[]): ProfilePeriod[] {
  const grouped = new Map<string, WorkRow[]>();
  for (const work of works) {
    const year = work.updated_at ? work.updated_at.slice(0, 4) : '';
    if (!/^\d{4}$/.test(year)) continue;
    grouped.set(year, [...(grouped.get(year) ?? []), work]);
  }

  const seenTags = new Set<string>();
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, items]) => {
      const tagCount = new Map<string, number>();
      for (const work of items) {
        for (const tag of work.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
      }
      const ranked = [...tagCount.entries()].sort((a, b) => b[1] - a[1]);
      const newTags = ranked
        .map(([tag]) => tag)
        .filter((tag) => !seenTags.has(tag))
        .slice(0, 10);
      for (const [tag] of ranked) seenTags.add(tag);

      const rated = items.filter((work) => work.rate > 0);
      const formatCount = new Map<string, number>();
      for (const work of items) formatCount.set(work.format, (formatCount.get(work.format) ?? 0) + 1);
      const topFormat = [...formatCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      return {
        period,
        count: items.length,
        ratedCount: rated.length,
        averageRate:
          rated.length > 0
            ? round(rated.reduce((sum, work) => sum + work.rate, 0) / rated.length)
            : null,
        topTags: ranked.slice(0, 6).map(([tag]) => tag),
        newTags,
        tagEntropy: shannonEntropy([...tagCount.values()]),
        topFormat,
      };
    });
}

function buildBreadth(
  works: WorkRow[],
  periods: ProfilePeriod[],
  isThematic: TagFilter,
): ProfileBreadth {
  const tagCount = new Map<string, number>();
  let highDistinct = new Set<string>();
  const studios = new Set<string>();
  const directors = new Set<string>();
  const formats = new Set<string>();

  for (const work of works) {
    for (const tag of work.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    if (work.rate >= HIGH_RATE) highDistinct = new Set([...highDistinct, ...work.tags]);
    for (const studio of work.studios) studios.add(studio);
    for (const director of work.directors) directors.add(director);
    formats.add(work.format);
  }

  const total = works.length;
  // 广度与集中度只统计「有区分度」的标签，否则「日本 / TV」会把集中度算成 100%
  const informativeIncidence = [...tagCount.entries()]
    .filter(([tag, count]) => isThematic(tag) && count / Math.max(1, total) < UNIVERSAL_TAG_SHARE)
    .sort((a, b) => b[1] - a[1]);
  const incidence = [...tagCount.entries()].sort((a, b) => b[1] - a[1]);
  const top5 = incidence.slice(0, 5).map(([tag]) => tag);
  const informativeTop5 = informativeIncidence.slice(0, 5).map(([tag]) => tag);
  const coveredByTop5 = works.filter((work) =>
    work.tags.some((tag) => informativeTop5.includes(tag)),
  ).length;
  const informativeTotal = informativeIncidence.reduce((sum, [, count]) => sum + count, 0);
  const concentration = informativeIncidence.reduce(
    (sum, [, count]) => sum + (count / Math.max(1, informativeTotal)) ** 2,
    0,
  );

  const withEntropy = periods.filter((period) => period.tagEntropy !== null);
  // 至少要有 4 个阶段才能切成两段互不重叠的窗口，否则无法判断趋势
  const comparable = withEntropy.length >= 4;
  const half = Math.max(1, Math.floor(withEntropy.length / 2));
  const early = comparable ? withEntropy.slice(0, half) : [];
  const recent = comparable ? withEntropy.slice(-half) : [];
  const earlyEntropy =
    early.length > 0
      ? round(early.reduce((sum, period) => sum + (period.tagEntropy ?? 0), 0) / early.length)
      : null;
  const recentEntropy =
    recent.length > 0
      ? round(recent.reduce((sum, period) => sum + (period.tagEntropy ?? 0), 0) / recent.length)
      : null;

  const top5Share = total > 0 ? Number((coveredByTop5 / total).toFixed(4)) : null;
  const wideTags = incidence.length;
  const informativeTagCount = informativeIncidence.length;
  let verdict = '';
  if (earlyEntropy === null || recentEntropy === null) {
    verdict = `时间分段不足（当前只有 ${withEntropy.length} 个阶段，需要至少 4 个），暂时无法判断兴趣是扩大还是收窄。`;
  } else if (recentEntropy - earlyEntropy >= 0.3) {
    verdict = `兴趣范围在扩大：早期阶段的标签分散度 ${earlyEntropy}，最近阶段上升到 ${recentEntropy}。`;
  } else if (earlyEntropy - recentEntropy >= 0.3) {
    verdict = `兴趣范围在收窄：早期阶段的标签分散度 ${earlyEntropy}，最近阶段下降到 ${recentEntropy}。`;
  } else {
    verdict = `兴趣范围基本稳定：早期 ${earlyEntropy} 与最近 ${recentEntropy} 的标签分散度接近。`;
  }
  if (top5Share !== null && top5Share >= 0.6) {
    verdict += ` 同时，出现最多的 5 个「有区分度」标签覆盖了 ${Math.round(top5Share * 100)}% 的作品，说明结构上仍集中在少数模板。`;
  }

  return {
    distinctTags: wideTags,
    informativeTagCount,
    distinctTagsInHighRated: highDistinct.size,
    distinctStudios: studios.size,
    distinctDirectors: directors.size,
    distinctFormats: formats.size,
    top5TagShare: top5Share,
    concentration: Number(concentration.toFixed(4)),
    earlyPeriodEntropy: earlyEntropy,
    recentPeriodEntropy: recentEntropy,
    verdict,
  };
}

function confidenceFor(sample: number, strong = 40, medium = 15): ProfileClaim['confidence'] {
  if (sample >= strong) return 'high';
  if (sample >= medium) return 'medium';
  return 'low';
}

function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** 由数据直接得到的结论（不依赖 AI，前端默认展示）。 */
function buildClaims(input: {
  works: WorkRow[];
  tags: ProfileDimensionStat[];
  tagPairs: ProfileTagPair[];
  formats: ProfileDimensionStat[];
  length: ProfileLengthBucket[];
  series: ProfileSeriesStats;
  avoidance: ProfileAvoidance[];
  periods: ProfilePeriod[];
  breadth: ProfileBreadth;
  basics: ProfileDataset['basics'];
  highRated: number;
  rated: number;
  isThematic: TagFilter;
}): ProfileClaim[] {
  const claims: ProfileClaim[] = [];
  const { works, tags, tagPairs, formats, length, series, avoidance, periods, breadth, basics } = input;

  /* ---- 1. 核心审美模板：高分作品中最稳定的标签组合 ---- */
  // 头部结论要求足够的样本量：只有 3-5 部作品的组合不足以代表「稳定的偏好」
  const topPair = tagPairs.find((pair) => pair.count >= 8) ?? null;
  const mostCommonPair = [...tagPairs].sort((a, b) => b.count - a.count)[0] ?? null;
  if (topPair && input.highRated >= 5) {
    claims.push({
      id: 'core-template',
      title: '你的核心审美模板',
      statement: `在高分作品里最突出的题材组合是「${topPair.a} + ${topPair.b}」：${topPair.count} 部高分作品同时具备这两个类型标签（占高分作品的 ${percent(topPair.share)}，明显高于独立假设）。`,
      evidence: [
        `高分作品（≥${HIGH_RATE} 分）共 ${input.highRated} 部`,
        `「${topPair.a} + ${topPair.b}」共现 ${topPair.count} 次，独立假设下期望 ${topPair.expected} 次（区分度倍数 ${topPair.lift}）`,
        mostCommonPair && (mostCommonPair.a !== topPair.a || mostCommonPair.b !== topPair.b)
          ? `出现次数最多的组合则是「${mostCommonPair.a} + ${mostCommonPair.b}」（${mostCommonPair.count} 部，区分度 ${mostCommonPair.lift}）`
          : '',
        '统计口径：只使用 Bangumi 维基维护的类型标签（不含声优 / 作曲家 / 公司 / 作品名），并排除近义标签之间的冗余组合',
        `其余高频组合：${tagPairs
          .slice(1, 4)
          .map((pair) => `${pair.a}+${pair.b}(${pair.count})`)
          .join('、')}`,
      ].filter(Boolean),
      kind: 'data',
      confidence: confidenceFor(topPair.count, 10, 5),
    });
  } else {
    claims.push({
      id: 'core-template',
      title: '你的核心审美模板',
      statement: '高分作品数量还不足以稳定提取标签组合。',
      evidence: [
        `高分作品 ${input.highRated} 部`,
        `当前最强组合：${tagPairs[0] ? `「${tagPairs[0].a} + ${tagPairs[0].b}」仅 ${tagPairs[0].count} 部` : '无'}`,
        '要求：组合至少出现在 8 部高分作品中',
      ],
      kind: 'data',
      confidence: 'low',
      insufficient: '至少需要 5 部高分作品、且存在出现 3 次以上的标签组合。',
    });
  }

  /* ---- 2. 高分作品中明显更常见的标签 ---- */
  const liftTags = tags
    .filter(
      (tag) =>
        tag.count >= 10 && tag.lift !== null && tag.lift >= 1.2 && input.isThematic(tag.name),
    )
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0))
    .slice(0, 3);
  if (liftTags.length > 0) {
    claims.push({
      id: 'lift-tags',
      title: '你在什么标签上更容易给高分',
      statement: liftTags
        .map(
          (tag) =>
            `「${tag.name}」在高分作品中的占比 ${percent(tag.highShare)}，是它在全部收藏中占比（${percent(tag.share)}）的 ${tag.lift} 倍`,
        )
        .join('；'),
      evidence: liftTags.map(
        (tag) => `「${tag.name}」共 ${tag.count} 部，其中高分 ${Math.round((tag.highShare ?? 0) * input.highRated)} 部，平均评分 ${tag.averageRate ?? '—'}`,
      ),
      kind: 'data',
      confidence: confidenceFor(liftTags[0]!.count, 30, 12),
    });
  }

  /* ---- 3. 结构与长度偏好 ---- */
  const bestLength = [...length]
    .filter((bucket) => bucket.count >= 5 && bucket.averageRate !== null)
    .sort((a, b) => (b.averageRate ?? 0) - (a.averageRate ?? 0))[0];
  const bestFormat = [...formats]
    .filter((format) => format.count >= 8 && format.averageRate !== null)
    .sort((a, b) => (b.averageRate ?? 0) - (a.averageRate ?? 0))[0];
  claims.push({
    id: 'structure',
    title: '作品结构与形态偏好',
    statement: [
      bestLength
        ? `按集数分档，你的平均评分最高的是「${bestLength.bucket}」（${bestLength.count} 部，平均 ${bestLength.averageRate} 分）`
        : null,
      bestFormat
        ? `按放送形态，评分最高的是「${bestFormat.name}」（${bestFormat.count} 部，平均 ${bestFormat.averageRate} 分）`
        : null,
      series.groupCount > 0
        ? `系列作品平均 ${series.averageRateGrouped ?? '—'} 分，独立作品平均 ${series.averageRateStandalone ?? '—'} 分`
        : '当前没有识别出多部作品的系列',
    ]
      .filter(Boolean)
      .join('；'),
    evidence: [
      `系列分组 ${series.groupCount} 组，覆盖 ${series.groupedWorks} 部；独立作品 ${series.standaloneWorks} 部`,
      ...length
        .slice(0, 4)
        .map((bucket) => `${bucket.bucket}：${bucket.count} 部，平均 ${bucket.averageRate ?? '—'} 分`),
    ],
    kind: 'data',
    confidence: confidenceFor(Math.max(bestLength?.count ?? 0, series.groupedWorks), 40, 15),
  });

  /* ---- 4. 评分倾向（与大众的关系） ---- */
  claims.push({
    id: 'rating-bias',
    title: '你与大众评分的距离',
    statement:
      basics.meanDelta === null
        ? '可比较的评分样本不足。'
        : `在可比较的作品中，你的评分平均${basics.meanDelta >= 0 ? '高于' : '低于'} Bangumi 平均分 ${Math.abs(basics.meanDelta).toFixed(2)} 分（标准差 ${basics.deltaStdDev ?? '—'}）`,
    evidence: [
      `已评分 ${input.rated} 部，其中 ${input.highRated} 部在 ${HIGH_RATE} 分以上`,
      `平均我的评分 ${basics.averageRate ?? '—'}，Bangumi 平均 ${basics.averageBgmScore ?? '—'}`,
    ],
    kind: 'data',
    confidence: confidenceFor(input.rated, 60, 20),
  });

  /* ---- 5. 兴趣边界与集中度 ---- */
  claims.push({
    id: 'breadth',
    title: '兴趣边界与集中度',
    statement: breadth.verdict,
    evidence: [
      `收藏共涉及 ${breadth.distinctTags} 个不同标签，其中 ${breadth.distinctTagsInHighRated} 个出现在高分作品里`,
      `排除「日本 / TV / 年份」等无区分度标签后，实际参与偏好判断的标签有 ${breadth.informativeTagCount} 个`,
      `覆盖 ${breadth.distinctStudios} 家制作公司、${breadth.distinctDirectors} 位导演、${breadth.distinctFormats} 种放送形态`,
      `最有区分度的前 5 个标签覆盖 ${percent(breadth.top5TagShare)} 的作品`,
    ],
    kind: 'data',
    confidence: confidenceFor(works.length, 80, 30),
  });

  /* ---- 6. 可能主动避开的模式（推测） ---- */
  if (avoidance.length > 0) {
    claims.push({
      id: 'avoidance',
      title: '你可能会主动避开的模式',
      statement: avoidance
        .slice(0, 3)
        .map((item) => `${item.dimension}「${item.name}」：${item.note}`)
        .join('；'),
      evidence: avoidance.slice(0, 5).map((item) => {
        const status = Object.entries(item.statusCounts)
          .map(([type, count]) => `${COLLECTION_TYPE_LABEL[Number(type) as 1] ?? type} ${count}`)
          .join('、');
        return `「${item.name}」（${item.dimension}）：${item.count} 部，平均我的评分 ${item.averageRate ?? '—'}，状态分布 ${status}`;
      }).concat([
        '口径说明：只统计接触量达到阈值且不属于人名 / 公司名 / 作品名的标签；这类推断受样本量影响较大，请结合状态分布自行判断',
      ]),
      kind: 'inference',
      confidence: confidenceFor(avoidance[0]!.count, 15, 6),
    });
  } else {
    claims.push({
      id: 'avoidance',
      title: '你可能会主动避开的模式',
      statement: '当前数据里没有出现「明显反复尝试且持续低评价」的类别。',
      evidence: ['判断条件：同一分类接触 ≥4 部且平均分比你整体平均低 0.6 分以上，或有 ≥25% 被搁置/抛弃'],
      kind: 'inference',
      confidence: 'low',
      insufficient: '需要更多同类型作品的评分与状态变化才能判断回避倾向。',
    });
  }

  /* ---- 7. 阶段性兴趣变化 ---- */
  const periodsWithRate = periods.filter((period) => period.averageRate !== null);
  if (periodsWithRate.length >= 3) {
    const first = periodsWithRate[0]!;
    const last = periodsWithRate[periodsWithRate.length - 1]!;
    claims.push({
      id: 'period-drift',
      title: '兴趣随时间的变化',
      statement: `按收藏活动年份看，${first.period} 年的平均评分为 ${first.averageRate}（${first.count} 部），${last.period} 年为 ${last.averageRate}（${last.count} 部）；最近阶段出现的新标签包括 ${last.newTags.slice(0, 5).join('、') || '—'}。`,
      evidence: periodsWithRate
        .slice(-6)
        .map(
          (period) =>
            `${period.period}：${period.count} 部，平均 ${period.averageRate} 分，主要标签 ${period.topTags.slice(0, 3).join('/')}`,
        ),
      kind: 'data',
      confidence: confidenceFor(periodsWithRate.reduce((sum, period) => sum + period.count, 0), 100, 40),
    });
  } else {
    claims.push({
      id: 'period-drift',
      title: '兴趣随时间的变化',
      statement: '当前数据的时间跨度不足，无法判断兴趣变化。',
      evidence: [`可分析的活动年份：${periods.length} 个`],
      kind: 'data',
      confidence: 'low',
      insufficient: '需要至少 3 个年份的收藏活动记录（这是本工具第一次同步，后续会逐步积累）。',
    });
  }

  return claims;
}

/** 构建完整画像数据集。 */
export function buildProfileDataset(visibility: Visibility = currentVisibility()): ProfileDataset {
  // v1.8：整页单口径 —— 作品样本与所有分析维度都必须使用同一个 visibility token。
  const works = loadWorks(visibility);
  const total = works.length;
  const rated = works.filter((work) => work.rate > 0);
  const highRatedWorks = works.filter((work) => work.rate >= HIGH_RATE);
  const lowRatedWorks = works.filter((work) => work.rate > 0 && work.rate <= LOW_RATE);
  const overallAverageRate =
    rated.length > 0 ? Number((rated.reduce((sum, work) => sum + work.rate, 0) / rated.length).toFixed(2)) : null;

  const tagRows = tagStats(visibility);
  const tags = tagDimensionStats(tagRows, total, highRatedWorks.length);
  const isThematic = createThematicTagFilter(loadNonThematicNames());
  // 「审美模板」只使用 Bangumi 维基维护的类型标签（meta_tags），
  // 它们描述的是题材本身，不会混入声优 / 作曲家 / 公司 / 作品名等噪声。
  const metaTags = loadMetaTagVocabulary();
  const tagPairs = buildTagPairs(works, (name) => metaTags.has(name.trim()));
  const formats = columnDimensionStats('s.format', { visibility });
  const seasons = columnDimensionStats('s.season', { visibility, where: 's.season IS NOT NULL' });
  const originals = jsonDimensionStats('originals', visibility);
  const studios = jsonDimensionStats('studios', visibility);
  const directors = jsonDimensionStats('directors', visibility);
  const length = buildLengthBuckets(works);
  const series = seriesStats(visibility);
  // 「明显会避开什么」只统计维基维护的类型标签，避免出现「你在避开某位声优」这类误判
  const avoidance = buildAvoidance(
    works,
    tagRows.filter((tag) => metaTags.has(tag.name)),
    overallAverageRate,
    isThematic,
    visibility,
  );
  const periods = buildPeriods(works);
  const breadth = buildBreadth(works, periods, isThematic);

  const ratedValues = rated.map((work) => work.rate).sort((a, b) => a - b);
  const medianRate =
    ratedValues.length === 0
      ? null
      : ratedValues.length % 2 === 1
        ? ratedValues[(ratedValues.length - 1) / 2]!
        : (ratedValues[ratedValues.length / 2 - 1]! + ratedValues[ratedValues.length / 2]!) / 2;

  const deltas = works
    .filter((work) => work.rate > 0 && work.score !== null && work.score > 0)
    .map((work) => work.rate - (work.score as number));
  const meanDelta =
    deltas.length > 0 ? Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(2)) : null;
  const deltaStdDev =
    deltas.length > 1 && meanDelta !== null
      ? Number(
          Math.sqrt(
            deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (deltas.length - 1),
          ).toFixed(2),
        )
      : null;

  const yearRow = one<{ min: number | null; max: number | null }>(
    `SELECT MIN(canonical_positive_integer(s.year)) AS min, MAX(canonical_positive_integer(s.year)) AS max
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE ${subjectVisibilityClause('s', visibility)}`,
  );

  const basics: ProfileDataset['basics'] = {
    statusCounts: statusCountsOf(works),
    averageRate: overallAverageRate,
    medianRate: round(medianRate),
    averageBgmScore:
      works.filter((work) => work.score && work.score > 0).length > 0
        ? round(
            works
              .filter((work) => work.score && work.score > 0)
              .reduce((sum, work) => sum + (work.score as number), 0) /
              works.filter((work) => work.score && work.score > 0).length,
          )
        : null,
    meanDelta,
    deltaStdDev,
    completionRate: total > 0 ? Number(((works.filter((work) => work.type === 2).length / total) || 0).toFixed(4)) : 0,
    watchedEpisodes: works.reduce((sum, work) => sum + work.watchedEpisodes, 0),
    totalEpisodes: works.reduce((sum, work) => sum + work.episodes, 0),
  };

  const claims = buildClaims({
    works,
    tags,
    tagPairs,
    formats,
    length,
    series,
    avoidance,
    periods,
    breadth,
    basics,
    highRated: highRatedWorks.length,
    rated: rated.length,
    isThematic,
  });

  return {
    visibility,
    personalRatingPolicy: 'exclude-wish-v1',
    generatedAt: nowIso(),
    dataVersion: dataVersion(),
    sample: {
      total,
      rated: rated.length,
      highRated: highRatedWorks.length,
      lowRated: lowRatedWorks.length,
      yearFrom: yearRow?.min === null || yearRow?.min === undefined ? null : Number(yearRow.min),
      yearTo: yearRow?.max === null || yearRow?.max === undefined ? null : Number(yearRow.max),
      datedSample: works.filter((work) => work.updated_at).length,
    },
    basics,
    tags,
    tagPairs,
    formats,
    seasons,
    originals,
    studios,
    directors,
    length,
    series,
    avoidance,
    periods,
    breadth,
    claims,
    samples: {
      highRated: highRatedWorks
        .sort((a, b) => b.rate - a.rate || (b.score ?? 0) - (a.score ?? 0))
        .slice(0, SAMPLE_LIMIT)
        .map(toSample),
      lowRated: lowRatedWorks
        .sort((a, b) => a.rate - b.rate || (a.score ?? 0) - (b.score ?? 0))
        .slice(0, SAMPLE_LIMIT)
        .map(toSample),
      abandoned: works
        .filter((work) => work.type === 4 || work.type === 5)
        .slice(0, SAMPLE_LIMIT)
        .map(toSample),
    },
  };
}
