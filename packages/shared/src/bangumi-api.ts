/**
 * Bangumi 官方 API（v0）响应结构定义与容错解析。
 *
 * 设计原则：
 * 1. 用宽松 schema 解析已知字段，字段缺失/类型变化不会导致整页数据丢失；
 * 2. 原始 JSON 始终原样保存到数据库（`raw` 列），未来新增分析维度时无需重新请求；
 * 3. 解析失败只影响单条数据，并通过 `issues` 上报，由同步引擎记录为「数据异常」。
 */

import { z } from 'zod';

const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (typeof value === 'string' ? value : ''));

export const bgmImagesSchema = z
  .object({
    large: nullableString,
    common: nullableString,
    medium: nullableString,
    small: nullableString,
    grid: nullableString,
  })
  .partial()
  .catch({});

export type BgmImages = z.infer<typeof bgmImagesSchema>;

export const bgmTagSchema = z.object({
  name: z.string(),
  count: z.number().int().catch(0),
  total_count: z.number().int().catch(0),
});

export const bgmInfoboxItemSchema = z.object({
  key: z.string(),
  value: z.unknown(),
});

export const bgmSlimSubjectSchema = z.object({
  id: z.number().int().positive(),
  type: z.number().int().catch(2),
  name: z.string().catch(''),
  name_cn: nullableString,
  short_summary: nullableString,
  date: nullableString,
  images: bgmImagesSchema.optional(),
  volumes: z.number().int().catch(0),
  eps: z.number().int().min(0).optional().catch(undefined),
  collection_total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
  score: z.number().catch(0),
  rank: z.number().int().catch(0),
  tags: z.array(bgmTagSchema).catch([]),
});

export const bgmCollectionItemSchema = z.object({
  subject_id: z.number().int().positive(),
  subject_type: z.number().int().refine((value) => [1, 2, 3, 4, 6].includes(value)).default(2),
  rate: z.number().int().min(0).max(10).default(0),
  type: z.number().int().min(1).max(5),
  comment: nullableString,
  tags: z.array(z.string()).default([]),
  ep_status: z.number().int().min(0).default(0),
  vol_status: z.number().int().min(0).default(0),
  updated_at: nullableString,
  private: z.boolean().default(false),
  subject: bgmSlimSubjectSchema.optional(),
}).superRefine((item, ctx) => {
  if (item.subject && (item.subject.id !== item.subject_id || item.subject.type !== item.subject_type)) {
    ctx.addIssue({ code: 'custom', path: ['subject'], message: '收藏主体与内嵌作品身份不一致' });
  }
});

export type BgmCollectionItem = z.infer<typeof bgmCollectionItemSchema>;

export const bgmCollectionPageSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().catch(0),
  offset: z.number().int().catch(0),
  data: z.array(z.unknown()),
});

export const bgmRatingSchema = z
  .object({
    rank: z.number().int().catch(0),
    total: z.number().int().nonnegative().nullable().catch(null),
    score: z.number().catch(0),
    count: z.record(z.string(), z.number()).catch({}),
  })
  .catch({ rank: 0, total: null, score: 0, count: {} });

export const bgmCollectionStatsSchema = z
  .object({
    wish: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    collect: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    doing: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    on_hold: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    dropped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((counts) => Number.isSafeInteger(Object.values(counts).reduce((sum, count) => sum + count, 0)),
    { message: '收藏人数合计超出安全整数范围' });

export const bgmSubjectSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.number().int().catch(2),
  name: z.string().catch(''),
  name_cn: nullableString,
  summary: nullableString,
  series: z.boolean().catch(false),
  // 缺失/非法不是明确 false，合并时保留已有上游标记。
  nsfw: z.boolean().optional().catch(undefined),
  locked: z.boolean().catch(false),
  date: nullableString,
  platform: nullableString,
  images: bgmImagesSchema.optional(),
  infobox: z.array(bgmInfoboxItemSchema).catch([]),
  volumes: z.number().int().catch(0),
  eps: z.number().int().min(0).optional().catch(undefined),
  total_episodes: z.number().int().catch(0),
  rating: bgmRatingSchema,
  collection: bgmCollectionStatsSchema,
  meta_tags: z.array(z.string()).catch([]),
  tags: z.array(bgmTagSchema).catch([]),
});

export type BgmSubject = z.infer<typeof bgmSubjectSchema>;

export const bgmSubjectRelationSchema = z.object({
  id: z.number().int().positive(),
  type: z.number().int().refine((value) => [1, 2, 3, 4, 6].includes(value)).default(2),
  name: z.string().catch(''),
  name_cn: nullableString,
  relation: z.string().catch(''),
  images: bgmImagesSchema.optional(),
});

export type BgmSubjectRelation = z.infer<typeof bgmSubjectRelationSchema>;

export const bgmPersonSchema = z.object({
  id: z.number().int(),
  name: z.string().catch(''),
  type: z.number().int().catch(1),
  career: z.array(z.string()).catch([]),
  relation: z.string().catch(''),
  images: bgmImagesSchema.optional(),
});

export const bgmPersonRelationSchema = z.object({
  id: z.number().int(),
  name: z.string().catch(''),
  relation: z.string().catch(''),
  career: z.array(z.string()).catch([]),
  type: z.number().int().catch(1),
  images: bgmImagesSchema.optional(),
});

export type BgmPersonRelation = z.infer<typeof bgmPersonRelationSchema>;

export const bgmMeSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  nickname: z.string().catch(''),
  avatar: bgmImagesSchema.optional(),
  sign: nullableString,
});

export type BgmMe = z.infer<typeof bgmMeSchema>;

export interface ParseIssue {
  scope: string;
  subjectId?: number;
  message: string;
}

export interface ParseResult<T> {
  value: T | null;
  issues: ParseIssue[];
}

export function parseCollectionItem(raw: unknown): ParseResult<BgmCollectionItem> {
  const result = bgmCollectionItemSchema.safeParse(raw);
  if (result.success) return { value: result.data, issues: [] };
  const id =
    typeof raw === 'object' && raw !== null && 'subject_id' in raw
      ? Number((raw as { subject_id?: unknown }).subject_id)
      : undefined;
  return {
    value: null,
    issues: [
      {
        scope: 'collection',
        subjectId: Number.isFinite(id) ? id : undefined,
        message: result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      },
    ],
  };
}
