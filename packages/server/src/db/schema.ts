import type { DatabaseSync } from 'node:sqlite';

/**
 * 数据库结构。使用 `PRAGMA user_version` 做版本化迁移，
 * 迁移必须是「只增不改」的：新增分析维度时追加新的迁移步骤。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * 可选：在迁移执行前检查该迁移是否已经生效（列 / 表已存在）。
   * 返回 false 时只更新 `user_version`，不重复执行 SQL。
   *
   * 为什么需要它：SQLite 的 `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，
   * 遇到「列已存在」的库会直接报 duplicate column name 并让整个迁移失败。
   */
  isApplied?: (db: DatabaseSync) => boolean;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- 条目主表：既保存结构性字段（用于 SQL 聚合），也保存原始 JSON（用于未来扩展）
      CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY,
        type INTEGER NOT NULL DEFAULT 2,
        name TEXT NOT NULL DEFAULT '',
        name_cn TEXT NOT NULL DEFAULT '',
        aliases TEXT NOT NULL DEFAULT '[]',
        platform TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT '其他',
        date TEXT,
        year INTEGER,
        month INTEGER,
        season TEXT,
        year_month TEXT,
        year_quarter TEXT,
        eps INTEGER NOT NULL DEFAULT 0,
        total_episodes INTEGER NOT NULL DEFAULT 0,
        volumes INTEGER NOT NULL DEFAULT 0,
        score REAL,
        rank INTEGER,
        rating_total INTEGER,
        rating_dist TEXT,
        collection_stats TEXT,
        collection_total INTEGER NOT NULL DEFAULT 0,
        meta_tags TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        tag_names TEXT NOT NULL DEFAULT '[]',
        infobox TEXT,
        studios TEXT NOT NULL DEFAULT '[]',
        directors TEXT NOT NULL DEFAULT '[]',
        originals TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        images TEXT NOT NULL DEFAULT '{}',
        cover_url TEXT,
        nsfw INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0,
        is_series INTEGER NOT NULL DEFAULT 0,
        series_key TEXT,
        series_source TEXT,
        raw TEXT,
        detail_state TEXT NOT NULL DEFAULT 'pending',
        detail_synced_at TEXT,
        detail_attempts INTEGER NOT NULL DEFAULT 0,
        detail_error TEXT,
        relations_state TEXT NOT NULL DEFAULT 'pending',
        relations_synced_at TEXT,
        relations_attempts INTEGER NOT NULL DEFAULT 0,
        persons_state TEXT NOT NULL DEFAULT 'pending',
        persons_synced_at TEXT,
        persons_attempts INTEGER NOT NULL DEFAULT 0,
        cover_cached_at TEXT,
        cover_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subjects_year ON subjects(year);
      CREATE INDEX IF NOT EXISTS idx_subjects_format ON subjects(format);
      CREATE INDEX IF NOT EXISTS idx_subjects_score ON subjects(score);
      CREATE INDEX IF NOT EXISTS idx_subjects_series_key ON subjects(series_key);
      CREATE INDEX IF NOT EXISTS idx_subjects_detail_state ON subjects(detail_state);
      CREATE INDEX IF NOT EXISTS idx_subjects_name ON subjects(name);
      CREATE INDEX IF NOT EXISTS idx_subjects_name_cn ON subjects(name_cn);

      -- 用户收藏（与条目一对一，存储用户侧数据）
      CREATE TABLE IF NOT EXISTS collections (
        subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
        subject_type INTEGER NOT NULL DEFAULT 2,
        type INTEGER NOT NULL,
        rate INTEGER NOT NULL DEFAULT 0,
        ep_status INTEGER NOT NULL DEFAULT 0,
        vol_status INTEGER NOT NULL DEFAULT 0,
        comment TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        private INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        -- first_seen_at = 本地首次入库时间，不是用户在 Bangumi 的真实收藏创建时间（v1.8 P0-C）
        first_seen_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        raw TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_collections_type ON collections(type);
      CREATE INDEX IF NOT EXISTS idx_collections_rate ON collections(rate);
      CREATE INDEX IF NOT EXISTS idx_collections_updated ON collections(updated_at);

      -- 制作人员（来源可能是 infobox 解析或官方 persons 接口）
      CREATE TABLE IF NOT EXISTS subject_staff (
        subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        person_id INTEGER,
        name TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT '',
        career TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        PRIMARY KEY (subject_id, name, relation, source)
      );

      CREATE INDEX IF NOT EXISTS idx_staff_name ON subject_staff(name);
      CREATE INDEX IF NOT EXISTS idx_staff_relation ON subject_staff(relation);
      CREATE INDEX IF NOT EXISTS idx_staff_person ON subject_staff(person_id);

      -- 条目关联（官方「系列关系」数据）
      CREATE TABLE IF NOT EXISTS subject_relations (
        subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        related_id INTEGER NOT NULL,
        relation TEXT NOT NULL DEFAULT '',
        type INTEGER NOT NULL DEFAULT 2,
        name TEXT NOT NULL DEFAULT '',
        name_cn TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, related_id)
      );

      CREATE INDEX IF NOT EXISTS idx_relations_related ON subject_relations(related_id);

      -- 系列 / IP 分组结果（由官方关系 + 标题启发式计算得到，可随时重建）
      CREATE TABLE IF NOT EXISTS series (
        key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        total_episodes INTEGER NOT NULL DEFAULT 0,
        average_rate REAL,
        collected_count INTEGER NOT NULL DEFAULT 0,
        first_year INTEGER,
        last_year INTEGER,
        status_counts TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS series_members (
        series_key TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (series_key, subject_id)
      );

      CREATE INDEX IF NOT EXISTS idx_series_members_subject ON series_members(subject_id);

      -- 同步运行记录
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        counters TEXT NOT NULL DEFAULT '{}',
        warnings TEXT NOT NULL DEFAULT '[]',
        issues TEXT NOT NULL DEFAULT '[]',
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

      -- 分页抓取暂存区：全部分页成功后才应用到正式表
      CREATE TABLE IF NOT EXISTS sync_stage (
        run_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        page_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, subject_id)
      );
    `,
  },
  {
    version: 2,
    name: 'sync-stage-index',
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS idx_sync_stage_run ON sync_stage(run_id);
    `,
  },
  {
    version: 3,
    name: 'sync-run-heartbeat',
    sql: /* sql */ `
      -- 心跳用于区分「真正崩溃的同步」与「另一个进程正在同步」，
      -- 避免多开程序时把正在运行的同步误标为已中断。
      ALTER TABLE sync_runs ADD COLUMN heartbeat_at TEXT;
    `,
  },
  {
    version: 4,
    name: 'complete-tag-names-and-profile-tables',
    sql: /* sql */ `
      -- 1) 修复标签数据：早期版本把每个条目的标签截断为前 24 个。
      --    这里直接用已经保存的完整 tags 原始字段重建，**不需要重新同步**。
      UPDATE subjects
      SET tag_names = COALESCE((
        SELECT json_group_array(name)
        FROM (
          SELECT json_extract(je.value, '$.name') AS name, MIN(je.key) AS first_pos
          FROM json_each(subjects.tags) AS je
          WHERE json_extract(je.value, '$.name') IS NOT NULL
            AND TRIM(json_extract(je.value, '$.name')) <> ''
          GROUP BY json_extract(je.value, '$.name')
          ORDER BY first_pos ASC
        )
      ), '[]')
      WHERE json_valid(tags) AND json_array_length(tags) > 0;

      -- 2) 画像阶段快照（支持阶段性复盘与 Rank 复盘）
      CREATE TABLE IF NOT EXISTS profile_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage_label TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        rank_from INTEGER,
        rank_to INTEGER,
        candidate_ids TEXT,
        created_at TEXT NOT NULL,
        collection_count INTEGER NOT NULL,
        rated_count INTEGER NOT NULL,
        average_rate REAL,
        dataset TEXT NOT NULL,
        /* JSON：{ "<subjectId>": [收藏状态, 我的评分] }，用于阶段对比 */
        members TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_profile_snapshots_created
        ON profile_snapshots(created_at DESC);

      -- 3) AI 画像报告缓存（同一份数据只生成一次）
      CREATE TABLE IF NOT EXISTS profile_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        output TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_profile_reports_created
        ON profile_reports(created_at DESC);
    `,
  },
  {
    version: 5,
    name: 'summary-translation',
    sql: /* sql */ `
      -- 简介双语：原文（Bangumi summary 原样）与 AI 中文翻译分开存放。
      -- 关键约束：AI 结果只写 summary_zh_ai，
      -- 既不覆盖 summary（Bangumi 一手原文），也不覆盖官方中文简介。
      -- 原文快照（可能是日文，也可能是其他语言，内容原样保存）
      ALTER TABLE subjects ADD COLUMN summary_original TEXT NOT NULL DEFAULT '';
      -- 原文指纹：归一化后的 hash，用于「原文没变就不重复翻译」
      ALTER TABLE subjects ADD COLUMN summary_original_hash TEXT NOT NULL DEFAULT '';
      -- 原文语言：ja / zh / other / empty（真实数据里中文与日文都存在）
      ALTER TABLE subjects ADD COLUMN summary_original_lang TEXT NOT NULL DEFAULT '';
      -- AI 生成的中文翻译（持久化在本机数据库，断网也能显示）
      ALTER TABLE subjects ADD COLUMN summary_zh_ai TEXT NOT NULL DEFAULT '';
      /*
       * Bangumi 官方中文简介。
       * 来源有两类：
       *   1. summary 本身就是中文；
       *   2. summary 是「日文原文 + [中文简介] + 中文」的混合双语格式（实测存在）。
       * 混合格式在入库时会被拆开：日文部分进 summary_original，中文部分进这一列，
       * 原始 summary 保持原样不动。
       */
      ALTER TABLE subjects ADD COLUMN summary_zh_official TEXT NOT NULL DEFAULT '';
      -- 翻译状态：idle / pending / processing / completed / failed / waiting_ai
      ALTER TABLE subjects ADD COLUMN summary_zh_ai_status TEXT NOT NULL DEFAULT 'idle';
      -- 本次翻译所依据的原文 hash：与 summary_original_hash 不一致说明「翻译基于旧版原文」
      ALTER TABLE subjects ADD COLUMN summary_zh_ai_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE subjects ADD COLUMN summary_zh_ai_model TEXT NOT NULL DEFAULT '';
      ALTER TABLE subjects ADD COLUMN summary_zh_ai_provider TEXT NOT NULL DEFAULT '';
      ALTER TABLE subjects ADD COLUMN summary_zh_ai_updated_at TEXT;
      ALTER TABLE subjects ADD COLUMN summary_zh_ai_error TEXT;
      -- 中文简介的来源：bangumi（官方中文）/ ai（本地翻译）/ none
      ALTER TABLE subjects ADD COLUMN summary_zh_source TEXT NOT NULL DEFAULT 'none';

      CREATE INDEX IF NOT EXISTS idx_subjects_summary_status
        ON subjects(summary_zh_ai_status);
      CREATE INDEX IF NOT EXISTS idx_subjects_summary_lang
        ON subjects(summary_original_lang);

      -- 翻译任务队列：一次翻译 = 一行；原文 hash 变化会产生新的一行，
      -- 旧行保留为历史（便于追溯），未完成的旧任务会被标记为 superseded。
      CREATE TABLE IF NOT EXISTS translation_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        source_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        next_attempt_at TEXT
      );

      -- 同一作品 + 同一原文 hash 只会有一行（去重，避免重复消耗 token）
      CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_jobs_subject_hash
        ON translation_jobs(subject_id, source_hash);
      CREATE INDEX IF NOT EXISTS idx_translation_jobs_queue
        ON translation_jobs(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_translation_jobs_status
        ON translation_jobs(status);
    `,
  },
  {
    version: 6,
    name: 'official-chinese-summary',
    sql: /* sql */ `
      -- v6 只做无副作用的准备（见 v7 的说明）
      SELECT 1;
    `,
  },
  {
    version: 7,
    name: 'official-chinese-summary-column',
    sql: /* sql */ `
      /*
       * Bangumi 官方中文简介单独存一列。
       *
       * 真实数据里存在「日文原文 + [中文简介] + 官方中文」的混合 summary
       * （实测 4 条）。入库时会拆成：
       *   summary             → 原始 summary，保持原样（一手数据）
       *   summary_original    → 分隔标记之前的日文原文
       *   summary_zh_official → 分隔标记之后的官方中文
       * 纯中文 summary 则整段进这一列。
       *
       * 该列在开发过程中已经存在于部分本地数据库，
       * 因此用 isApplied 先判断，已存在就只更新 user_version。
       */
      ALTER TABLE subjects ADD COLUMN summary_zh_official TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_subjects_summary_official
        ON subjects(summary_zh_official);
    `,
    isApplied: (db) =>
      (db.prepare(`SELECT 1 FROM pragma_table_info('subjects') WHERE name = 'summary_zh_official'`).all() as unknown[]).length > 0,
  },
  {
    version: 8,
    name: 'obsolete-translation-jobs',
    sql: /* sql */ `
      /*
       * 历史失效任务治理（数据迁移，无结构变化）。
       *
       * 原文 hash 变化后，旧任务的结果不再对应当前原文：
       *   - 旧任务保留为历史记录，但状态改为 obsolete，不再参与队列与「失败」统计；
       *   - 旧翻译本身保存在 subjects.summary_zh_ai 里，不删除（作为旧版本 fallback）；
       *   - 新的 source_hash 会建立新的 pending 任务。
       *
       * 这样「失败」只统计当前 hash 下确实需要处理的任务。
       */
      UPDATE translation_jobs
         SET status = 'obsolete',
             last_error = COALESCE(last_error, '原文已更新，该任务的历史结果不再对应当前原文')
       WHERE EXISTS (
         SELECT 1 FROM subjects s
          WHERE s.id = translation_jobs.subject_id
            AND s.summary_original_hash <> translation_jobs.source_hash
       );
    `,
  },
  {
    version: 9,
    name: 'series-franchise-entities',
    sql: /* sql */ `
      /*
       * Series / Franchise 语义重构（v1.5.1）。
       *
       * 旧模型把「官方关系 → 并查集 → 由收藏成员派生的 group」压成一层，
       * 实体 key 直接等于当前成员的最小 ID。这里引入独立的实体层：
       *
       *   series_entities            实体身份（key 不透明、不随成员变化）
       *   series_entity_members      成员资格 + 结构化理由（为什么属于这里）
       *   franchise_entities         Series 之上的作品家族
       *   franchise_series           家族成员 = Series（不是 subject）
       *   entity_aliases             旧 key / 被吸收实体的别名映射
       *   entity_events              合并 / 拆分 / 改名提案 / 冲突等历史
       *   series_legacy_snapshot     迁移前的旧分组快照（不丢历史）
       *
       * 旧表 series / series_members 保留不动，仅用于迁移追溯。
       */
      CREATE TABLE IF NOT EXISTS series_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'stable',
        title TEXT NOT NULL DEFAULT '',
        title_state TEXT NOT NULL DEFAULT 'unresolved',
        title_source TEXT NOT NULL DEFAULT 'fallback',
        title_candidates TEXT NOT NULL DEFAULT '[]',
        anchor_subject_id INTEGER,
        core_signature TEXT NOT NULL DEFAULT '',
        evidence_coverage TEXT NOT NULL DEFAULT 'full',
        member_count INTEGER NOT NULL DEFAULT 0,
        confirmed_count INTEGER NOT NULL DEFAULT 0,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        collected_count INTEGER NOT NULL DEFAULT 0,
        total_episodes INTEGER NOT NULL DEFAULT 0,
        average_rate REAL,
        first_year INTEGER,
        last_year INTEGER,
        status_counts TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_series_entities_state
        ON series_entities(state, member_count DESC);
      CREATE INDEX IF NOT EXISTS idx_series_entities_anchor
        ON series_entities(anchor_subject_id);

      CREATE TABLE IF NOT EXISTS series_entity_members (
        series_id INTEGER NOT NULL REFERENCES series_entities(id) ON DELETE CASCADE,
        subject_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        state TEXT NOT NULL DEFAULT 'probable',
        reason_code TEXT NOT NULL DEFAULT '',
        via_subject_id INTEGER,
        via_relation TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (series_id, subject_id)
      );

      CREATE INDEX IF NOT EXISTS idx_series_entity_members_subject
        ON series_entity_members(subject_id);

      CREATE TABLE IF NOT EXISTS franchise_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'candidate',
        title TEXT NOT NULL DEFAULT '',
        title_state TEXT NOT NULL DEFAULT 'unresolved',
        title_source TEXT NOT NULL DEFAULT 'fallback',
        title_candidates TEXT NOT NULL DEFAULT '[]',
        series_count INTEGER NOT NULL DEFAULT 0,
        confirmed_series_count INTEGER NOT NULL DEFAULT 0,
        candidate_series_count INTEGER NOT NULL DEFAULT 0,
        conflict_series_count INTEGER NOT NULL DEFAULT 0,
        known_count INTEGER NOT NULL DEFAULT 0,
        collected_count INTEGER NOT NULL DEFAULT 0,
        average_rate REAL,
        first_year INTEGER,
        last_year INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_franchise_entities_state
        ON franchise_entities(state, series_count DESC);

      CREATE TABLE IF NOT EXISTS franchise_series (
        franchise_id INTEGER NOT NULL REFERENCES franchise_entities(id) ON DELETE CASCADE,
        series_id INTEGER NOT NULL REFERENCES series_entities(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'candidate',
        evidence TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (franchise_id, series_id)
      );

      CREATE INDEX IF NOT EXISTS idx_franchise_series_series
        ON franchise_series(series_id);

      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias_key TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_kind TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entity_events_entity
        ON entity_events(entity_kind, entity_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS series_legacy_snapshot (
        old_key TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        member_ids TEXT NOT NULL DEFAULT '[]',
        captured_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO series_legacy_snapshot (old_key, title, source, member_ids, captured_at)
      SELECT s.key, s.title, s.source,
             COALESCE((
               SELECT json_group_array(m.subject_id) FROM series_members m WHERE m.series_key = s.key
             ), '[]'),
             datetime('now')
      FROM series s;
    `,
    isApplied: (db) =>
      (db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'series_entities'`)
        .all() as unknown[]).length > 0,
  },
  {
    version: 10,
    name: 'series-title-manual-confirmation',
    sql: /* sql */ `
      /*
       * Title Review / Manual Override（v1.5.1 收尾）。
       *
       * 只增加一个最小审计字段：人工确认时间。
       * - title_state = 'manual' 表示用户确认过的 canonical title；
       * - title_confirmed_at 记录确认时间，重建 / 同步都不会清除；
       * - 自动 resolver 只能生成 proposal，不得覆盖 manual 标题。
       */
      ALTER TABLE series_entities ADD COLUMN title_confirmed_at TEXT;
    `,
    isApplied: (db) =>
      (db
        .prepare(
          `SELECT 1 FROM pragma_table_info('series_entities') WHERE name = 'title_confirmed_at'`,
        )
        .all() as unknown[]).length > 0,
  },
  {
    version: 11,
    name: 'candidate-governance-decisions',
    sql: /* sql */ `
      /*
       * 候选治理（v1.6.1）：Analyzer 可以推断，但不拥有最终决定权。
       *
       * 这张表记录「用户对候选的明确决定」，是真实的治理状态而不是 UI 过滤：
       * - rejected：否决该候选（候选本身与来源证据继续保留在实体里用于解释）；
       * - superseded：后续出现更强证据，旧否决已失效（历史仍然可追溯）。
       *
       * candidate_key = 归一化后的候选身份（标题文本 / 系列 key 等），
       * evidence 保存作出决定时的候选证据快照，便于未来比较「是否出现新证据」。
       */
      CREATE TABLE IF NOT EXISTS candidate_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_kind TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        candidate_kind TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        candidate_title TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_decisions_key
        ON candidate_decisions(entity_kind, entity_id, candidate_kind, candidate_key);
      CREATE INDEX IF NOT EXISTS idx_candidate_decisions_entity
        ON candidate_decisions(entity_kind, entity_id, candidate_kind, decision);
    `,
    isApplied: (db) =>
      (db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'candidate_decisions'`)
        .all() as unknown[]).length > 0,
  },
  {
    version: 12,
    name: 'franchise-membership-exclusions',
    sql: /* sql */ `
      /*
       * Franchise 成员 / 名称治理（v1.7.0）。
       *
       * 成员移出是真实的治理事实，而不是 UI 过滤：
       * - 记录「用户否决了 Series X 属于 Franchise A」这一 membership 推断；
       * - 重建（recomputeSeries）时按当前证据重新计算成员，但排除仍然生效，
       *   resolver 不得静默把被移出的 Series 加回来；
       * - 撤销排除（reopen）把行标记为 revoked，保留原 reason / evidence 作为 provenance，
       *   之后是否重新纳入完全由当前证据决定，不强制加回；
       * - Franchise / Series / Subject / Relation / Collection 数据本身不变。
       */
      CREATE TABLE IF NOT EXISTS franchise_member_exclusions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        franchise_id INTEGER NOT NULL,
        series_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        reason TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '{}',
        actor TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_franchise_member_exclusions_franchise
        ON franchise_member_exclusions(franchise_id, state);
      CREATE INDEX IF NOT EXISTS idx_franchise_member_exclusions_series
        ON franchise_member_exclusions(series_id, state);
    `,
    isApplied: (db) =>
      (db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'franchise_member_exclusions'`,
        )
        .all() as unknown[]).length > 0,
  },
];

MIGRATIONS.push({
  version: 13,
  name: 'collection-total-source-state',
  // NULL preserves legacy ambiguity; do not infer or rewrite historical counts.
  sql: `ALTER TABLE subjects ADD COLUMN collection_total_known INTEGER
    CHECK(collection_total_known IS NULL OR collection_total_known IN (0, 1));`,
  isApplied: (db) => (db.prepare(
    `SELECT 1 FROM pragma_table_info('subjects') WHERE name = 'collection_total_known'`,
  ).all() as unknown[]).length > 0,
});

MIGRATIONS.push({
  version: 14,
  name: 'personal-rating-observations',
  // Add local evidence only; never infer a previous rating from today's wish row.
  sql: `
    CREATE TABLE IF NOT EXISTS collection_rating_history (
      owner_uid INTEGER NOT NULL CHECK(owner_uid > 0),
      subject_id INTEGER NOT NULL CHECK(subject_id > 0),
      prior_status INTEGER NOT NULL CHECK(prior_status IN (2, 3, 4, 5)),
      rate INTEGER NOT NULL CHECK(rate BETWEEN 1 AND 10),
      observed_at TEXT NOT NULL,
      transition_run_id INTEGER NOT NULL CHECK(transition_run_id > 0),
      PRIMARY KEY (owner_uid, subject_id)
    ) STRICT;
    INSERT INTO meta (key,value) VALUES ('personal_rating_projection_pending','1')
    ON CONFLICT (key) DO NOTHING;
  `,
});

MIGRATIONS.push({
  version: 15,
  name: 'manual-franchise-and-user-visibility',
  sql: `
    ALTER TABLE franchise_entities ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto'
      CHECK(origin IN ('auto','manual'));
    CREATE TABLE franchise_member_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      franchise_id INTEGER NOT NULL REFERENCES franchise_entities(id) ON DELETE RESTRICT,
      series_id INTEGER NOT NULL REFERENCES series_entities(id) ON DELETE RESTRICT,
      actor TEXT NOT NULL DEFAULT 'user',
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT
    ) STRICT;
    CREATE UNIQUE INDEX idx_active_franchise_assignment
      ON franchise_member_assignments(series_id) WHERE revoked_at IS NULL;
    CREATE INDEX idx_franchise_assignments_owner
      ON franchise_member_assignments(franchise_id,revoked_at);
    CREATE TABLE subject_user_hides (
      handle TEXT PRIMARY KEY,
      subject_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX idx_active_subject_user_hide
      ON subject_user_hides(subject_id) WHERE revoked_at IS NULL;
  `,
});

/** The existing quality contracts use unchanged source/projection inputs in 13–15.
 * Later migrations must be assessed explicitly, not admitted via LATEST_SCHEMA_VERSION.
 */
export function supportsQualitySchema(version: number): boolean {
  return version === 13 || version === 14 || version === 15;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
