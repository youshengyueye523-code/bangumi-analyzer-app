/**
 * Series / Franchise 证据解析器（纯函数，无数据库依赖）。
 *
 * 输入：全图节点（收藏 ∪ relation 引用）与分类后的关系边；
 * 输出：Series 分组 + 成员理由 + 候选合并 + Franchise 候选链接。
 *
 * 关键语义：
 * - continuity / derivation 形成 Series 核心；
 * - derivative 只做「卫星挂接」或「候选合并」，不会无差别合并两个核心；
 * - association（相同世界观/联动/角色出演）永远不产生 Series 成员资格；
 * - alternate（不同演绎/不同版本/三次元）永远不合并 Series，只进入 Franchise 候选；
 * - 无法判断时输出 candidate，而不是猜一个答案。
 */

import {
  classifyRelation,
  isFranchiseEvidenceClass,
  isTopologyClass,
  type RelationClass,
  type RelationPolarity,
} from './taxonomy.js';

export interface EngineNode {
  id: number;
  name: string;
  nameCn: string;
  year: number | null;
  totalEpisodes: number;
  /** 放送形态（TV / OVA / 剧场版 / WEB…），用于锚点选择，不参与成员资格 */
  format: string;
  collected: boolean;
  collectionType: number | null;
  rate: number;
  hasDetail: boolean;
  tags: string[];
  originals: string[];
  studios: string[];
  directors: string[];
}

export interface EngineEdge {
  from: number;
  to: number;
  relation: string;
  klass: RelationClass;
  polarity: RelationPolarity;
}

export type MemberState = 'confirmed' | 'probable' | 'candidate';
export type EvidenceCoverage = 'full' | 'partial' | 'relations-only';

export interface ResolvedMember {
  subjectId: number;
  role: 'primary' | 'candidate';
  state: MemberState;
  reasonCode: string;
  viaSubjectId: number | null;
  viaRelation: string | null;
}

export interface SeriesTitleInput {
  members: Array<{ title: string; core: boolean; tags: string[] }>;
  anchorTitle: string | null;
  singleton: boolean;
}

export interface ResolvedSeries {
  localId: number;
  primaryIds: number[];
  candidateIds: number[];
  coreIds: number[];
  anchorId: number | null;
  members: ResolvedMember[];
  state: 'stable' | 'provisional';
  coverage: EvidenceCoverage;
  titleInput: SeriesTitleInput;
  mergeCandidateLocalIds: number[];
}

export interface LinkEvidence {
  relations: string[];
  classes: RelationClass[];
  negativeRelations: string[];
  brand: string | null;
  tag: string | null;
  source: string | null;
}

export interface ResolvedLink {
  a: number;
  b: number;
  state: 'candidate' | 'provisional' | 'contested';
  evidence: LinkEvidence;
}

export interface ResolvedFranchise {
  localId: number;
  seriesLocalIds: number[];
  links: ResolvedLink[];
}

export interface ResolverOutput {
  series: ResolvedSeries[];
  franchises: ResolvedFranchise[];
  unknownRelations: Map<string, number>;
}

class UnionFind {
  private parent = new Map<number, number>();

  add(value: number): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: number): number {
    const current = this.parent.get(value);
    if (current === undefined) {
      this.parent.set(value, value);
      return value;
    }
    if (current === value) return value;
    const root = this.find(current);
    this.parent.set(value, root);
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

function compareEdges(a: EngineEdge, b: EngineEdge): number {
  return a.from - b.from || a.to - b.to || a.relation.localeCompare(b.relation, 'zh-Hans-CN');
}

function titleOf(node: EngineNode): string {
  return (node.nameCn || node.name || '').trim();
}

function stableSortIds(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

function normalizeTokens(values: string[]): string[] {
  return values
    .flatMap((value) => (value ?? '').split(/[、,，/／;；]/))
    .map((value) => value.trim().replace(/[\s\p{P}]/gu, '').toLowerCase())
    .filter((value) => value.length >= 2);
}

export interface ResolverOptions {
  /** 每个标签出现的条目数（用于稀有度过滤） */
  tagFrequency: Map<string, number>;
  /** 稀有标签阈值：超过该频次的标签不视为品牌证据 */
  rareTagLimit: number;
  /** 作者/公司/年份等噪声标签 */
  isExcludedTag: (tag: string) => boolean;
}

export function resolveGraph(
  nodes: Map<number, EngineNode>,
  edges: EngineEdge[],
  options: ResolverOptions,
): ResolverOutput {
  const unknownRelations = new Map<string, number>();
  const adjacency = new Map<number, EngineEdge[]>();
  for (const id of nodes.keys()) adjacency.set(id, []);
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge);
    adjacency.get(edge.to)?.push(edge);
    if (edge.klass === 'unknown') {
      unknownRelations.set(edge.relation, (unknownRelations.get(edge.relation) ?? 0) + 1);
    }
  }
  for (const list of adjacency.values()) list.sort(compareEdges);

  /* ---------------------------------------------------------------- 核心组件 */
  const uf = new UnionFind();
  for (const id of nodes.keys()) uf.add(id);
  for (const edge of edges) {
    if (isTopologyClass(edge.klass)) uf.union(edge.from, edge.to);
  }

  const coreMembers = new Map<number, number[]>();
  for (const id of nodes.keys()) {
    const root = uf.find(id);
    const list = coreMembers.get(root) ?? [];
    list.push(id);
    coreMembers.set(root, list);
  }

  /** owner：节点最终归属的组根。初始 = 所在核心根（核心>=2 人）或自身 */
  const owner = new Map<number, number>();
  const groupSize = new Map<number, number>();
  for (const [root, members] of coreMembers) {
    if (members.length >= 2) {
      for (const id of members) owner.set(id, root);
      groupSize.set(root, members.length);
    } else {
      owner.set(members[0]!, members[0]!);
      groupSize.set(members[0]!, 1);
    }
  }

  interface Attachment {
    subjectId: number;
    targetRoot: number;
    relation: string;
    viaSubjectId: number;
  }
  const attachments: Attachment[] = [];
  const ambiguous = new Map<number, Array<{ targetRoot: number; relation: string; via: number }>>();
  const mergePairs = new Map<string, { a: number; b: number; relation: string }>();

  const recordMergePair = (rootA: number, rootB: number, relation: string): void => {
    if (rootA === rootB) return;
    const a = Math.min(rootA, rootB);
    const b = Math.max(rootA, rootB);
    const key = `${a}:${b}`;
    const existing = mergePairs.get(key);
    if (!existing || relation.localeCompare(existing.relation, 'zh-Hans-CN') < 0) {
      mergePairs.set(key, { a, b, relation });
    }
  };

  // 多轮挂接：derivative 卫星链（A core - B - C）也能收敛
  for (let round = 0; round < 3; round += 1) {
    let changed = false;
    for (const node of nodes.values()) {
      // 已判定为「跨多个核心的候选」时保持候选状态，不再参与挂接。
      if (ambiguous.has(node.id)) continue;
      const currentOwner = owner.get(node.id)!;
      const selfSize = groupSize.get(currentOwner) ?? 1;
      const derivativeEdges = (adjacency.get(node.id) ?? []).filter(
        (edge) => edge.klass === 'derivative',
      );
      if (derivativeEdges.length === 0) continue;

      const targets = new Map<number, EngineEdge>();
      for (const edge of derivativeEdges) {
        const other = edge.from === node.id ? edge.to : edge.from;
        const root = owner.get(other);
        if (root === undefined || root === currentOwner) continue;
        if ((groupSize.get(root) ?? 1) < 2) continue;
        if (!targets.has(root)) targets.set(root, edge);
      }
      if (targets.size === 0) continue;

      if (selfSize >= 2) {
        // 已是核心成员：derivative 边指向另一个核心 → 只提出候选合并
        for (const root of targets.keys()) recordMergePair(currentOwner, root, targets.get(root)!.relation);
        continue;
      }

      if (targets.size === 1) {
        const [root, edge] = [...targets.entries()][0]!;
        owner.set(node.id, root);
        groupSize.set(root, (groupSize.get(root) ?? 1) + 1);
        attachments.push({
          subjectId: node.id,
          targetRoot: root,
          relation: edge.relation,
          viaSubjectId: edge.from === node.id ? edge.to : edge.from,
        });
        changed = true;
      } else {
        const list = ambiguous.get(node.id) ?? [];
        const targetRoots = [...targets.keys()];
        for (const [root, edge] of targets) {
          list.push({
            targetRoot: root,
            relation: edge.relation,
            via: edge.from === node.id ? edge.to : edge.from,
          });
          for (const otherRoot of targetRoots) {
            if (otherRoot !== root) recordMergePair(root, otherRoot, edge.relation);
          }
        }
        ambiguous.set(node.id, list);
      }
    }
    if (!changed) break;
  }

  /* ------------------------------------------------------------ 启发式分组 */
  const collectedUnattached = [...nodes.values()].filter((node) => {
    const root = owner.get(node.id)!;
    return node.collected && (groupSize.get(root) ?? 1) < 2 && !attachments.some((a) => a.subjectId === node.id) && !ambiguous.has(node.id);
  });

  const heuristicBuckets = new Map<string, number[]>();
  for (const node of collectedUnattached) {
    const key = heuristicKey(titleOf(node));
    if (!key) continue;
    const list = heuristicBuckets.get(key) ?? [];
    list.push(node.id);
    heuristicBuckets.set(key, list);
  }
  const heuristicRoots = new Map<number, number>();
  for (const [key, ids] of heuristicBuckets) {
    if (ids.length < 2) continue;
    const root = Math.min(...ids);
    for (const id of ids) {
      owner.set(id, root);
      heuristicRoots.set(id, root);
    }
    groupSize.set(root, ids.length);
  }

  /* --------------------------------------------------------------- 组装 Series */
  const groupIds = new Map<number, Set<number>>();
  for (const id of nodes.keys()) {
    const root = owner.get(id)!;
    const members = groupIds.get(root) ?? new Set<number>();
    members.add(id);
    groupIds.set(root, members);
  }

  const seriesByRoot = new Map<number, ResolvedSeries>();
  const seriesList: ResolvedSeries[] = [];

  const memberStateFor = (relation: string, klass: RelationClass): MemberState => {
    if (klass === 'continuity') return 'confirmed';
    return 'probable';
  };

  const attachmentBySubject = new Map(attachments.map((entry) => [entry.subjectId, entry]));

  const sortedRoots = [...groupIds.keys()].sort((a, b) => a - b);
  for (const root of sortedRoots) {
    const ids = groupIds.get(root)!;
    const nodeList = [...ids].map((id) => nodes.get(id)!).filter(Boolean);
    if (nodeList.length === 0) continue;
    if (!nodeList.some((node) => node.collected)) continue; // 纯未收藏拓扑不生成实体

    const isHeuristic = [...ids].every((id) => heuristicRoots.get(id) === root);

    // 成员理由：先 continuity/derivation 生成树，再补 derivative 挂接
    const primaryIds = stableSortIds(ids);
    const reasons = new Map<number, ResolvedMember>();
    // 收集组内全部拓扑边（保留方向，按 (from,to,relation) 去重）
    const internalEdges: EngineEdge[] = [];
    const seenEdgeKeys = new Set<string>();
    for (const id of primaryIds) {
      for (const edge of adjacency.get(id) ?? []) {
        if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
        const key = `${edge.from}:${edge.to}:${edge.relation}`;
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);
        internalEdges.push(edge);
      }
    }

    // 成员理由遍历使用无向视图：只要两端都在组内，任一方向的连续性/派生边都可解释归属。
    const topologyNeighbors = new Map<number, EngineEdge[]>();
    for (const edge of internalEdges) {
      if (!isTopologyClass(edge.klass)) continue;
      for (const item of [edge, { ...edge, from: edge.to, to: edge.from }]) {
        const list = topologyNeighbors.get(item.from) ?? [];
        list.push(item);
        topologyNeighbors.set(item.from, list);
      }
    }

    const anchor = pickAnchor(primaryIds, nodes);
    const visited = new Set<number>([anchor ?? primaryIds[0]!]);
    reasons.set(anchor ?? primaryIds[0]!, {
      subjectId: anchor ?? primaryIds[0]!,
      role: 'primary',
      state: isHeuristic ? 'probable' : 'confirmed',
      reasonCode: isHeuristic ? 'heuristic:title' : 'anchor',
      viaSubjectId: null,
      viaRelation: null,
    });
    const queue = [anchor ?? primaryIds[0]!];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of topologyNeighbors.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        reasons.set(edge.to, {
          subjectId: edge.to,
          role: 'primary',
          state: memberStateFor(edge.relation, edge.klass),
          reasonCode: `${edge.klass}:${edge.relation}`,
          viaSubjectId: current,
          viaRelation: edge.relation,
        });
        queue.push(edge.to);
      }
    }

    for (const id of primaryIds) {
      if (reasons.has(id)) continue;
      const attachment = attachmentBySubject.get(id);
      if (attachment) {
        const klass = classifyRelation(attachment.relation).klass;
        reasons.set(id, {
          subjectId: id,
          role: 'primary',
          state: memberStateFor(attachment.relation, klass),
          reasonCode: `derivative:${attachment.relation}`,
          viaSubjectId: attachment.viaSubjectId,
          viaRelation: attachment.relation,
        });
        continue;
      }
      const heuristic = isHeuristic || heuristicRoots.get(id) === root;
      reasons.set(id, {
        subjectId: id,
        role: 'primary',
        state: heuristic ? 'probable' : 'probable',
        reasonCode: heuristic ? 'heuristic:title' : 'derivative:unknown',
        viaSubjectId: null,
        viaRelation: null,
      });
    }

    const candidateMembers: ResolvedMember[] = [];
    for (const [subjectId, entries] of ambiguous) {
      if (ids.has(subjectId)) continue; // 同一组内不会同时是 primary 与 candidate
      let added = false;
      for (const entry of entries) {
        if (entry.targetRoot !== root) continue;
        if (added) break;
        candidateMembers.push({
          subjectId,
          role: 'candidate',
          state: 'candidate',
          reasonCode: `derivative:${entry.relation}`,
          viaSubjectId: entry.via,
          viaRelation: entry.relation,
        });
        added = true;
      }
    }

    const primaryNodes = primaryIds.map((id) => nodes.get(id)!).filter(Boolean);
    const collectedPrimary = primaryNodes.filter((node) => node.collected);
    const coverage: EvidenceCoverage =
      collectedPrimary.length === 0
        ? 'relations-only'
        : primaryNodes.every((node) => node.collected && node.hasDetail)
          ? 'full'
          : 'partial';

    const coreIds = isHeuristic
      ? primaryIds.filter((id) => !heuristicRoots.has(id))
      : primaryIds.filter((id) => {
          const list = topologyNeighbors.get(id);
          return Boolean(list && list.length > 0);
        });

    const series: ResolvedSeries = {
      localId: 0,
      primaryIds,
      candidateIds: stableSortIds(new Set(candidateMembers.map((member) => member.subjectId))),
      coreIds: coreIds.length > 0 ? coreIds : primaryIds,
      anchorId: anchor,
      members: [...reasons.values(), ...candidateMembers].sort((a, b) =>
        a.role === b.role
          ? a.subjectId - b.subjectId
          : a.role === 'primary'
            ? -1
            : 1,
      ),
      state: isHeuristic ? 'provisional' : 'stable',
      coverage,
      titleInput: {
        members: primaryNodes.map((node) => {
          const reason = reasons.get(node.id)?.reasonCode ?? '';
          const core =
            reason === 'anchor' ||
            reason.startsWith('continuity:') ||
            reason.startsWith('derivation:') ||
            isHeuristic;
          return { title: titleOf(node), core, tags: node.tags };
        }),
        anchorTitle: anchor !== null ? titleOf(nodes.get(anchor)!) : null,
        singleton: primaryNodes.length === 1,
      },
      mergeCandidateLocalIds: [],
    };
    seriesByRoot.set(root, series);
    seriesList.push(series);
  }

  seriesList.forEach((series, index) => {
    series.localId = index;
  });

  const localIdByRoot = new Map<number, number>();
  for (const [root, series] of seriesByRoot) localIdByRoot.set(root, series.localId);

  for (const pair of mergePairs.values()) {
    const a = localIdByRoot.get(pair.a);
    const b = localIdByRoot.get(pair.b);
    if (a === undefined || b === undefined || a === b) continue;
    seriesList[a]!.mergeCandidateLocalIds.push(b);
    seriesList[b]!.mergeCandidateLocalIds.push(a);
  }
  for (const series of seriesList) {
    series.mergeCandidateLocalIds = [...new Set(series.mergeCandidateLocalIds)].sort((x, y) => x - y);
  }

  /* ------------------------------------------------------------- Franchise */
  interface PairAccumulator {
    a: number;
    b: number;
    relations: Set<string>;
    classes: Set<RelationClass>;
    negativeRelations: Set<string>;
  }
  const pairs = new Map<string, PairAccumulator>();
  for (const edge of edges) {
    if (!isFranchiseEvidenceClass(edge.klass)) continue;
    const rootA = owner.get(edge.from);
    const rootB = owner.get(edge.to);
    if (rootA === undefined || rootB === undefined || rootA === rootB) continue;
    const a = localIdByRoot.get(rootA);
    const b = localIdByRoot.get(rootB);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const accumulator = pairs.get(key) ?? {
      a: Math.min(a, b),
      b: Math.max(a, b),
      relations: new Set<string>(),
      classes: new Set<RelationClass>(),
      negativeRelations: new Set<string>(),
    };
    if (edge.polarity === 'negative') accumulator.negativeRelations.add(edge.relation);
    else accumulator.relations.add(edge.relation);
    accumulator.classes.add(edge.klass);
    pairs.set(key, accumulator);
  }

  const links: ResolvedLink[] = [];
  for (const [key, accumulator] of [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const seriesA = seriesList[accumulator.a]!;
    const seriesB = seriesList[accumulator.b]!;
    const evidence: LinkEvidence = {
      relations: [...accumulator.relations].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      classes: [...accumulator.classes].sort(),
      negativeRelations: [...accumulator.negativeRelations].sort((a, b) =>
        a.localeCompare(b, 'zh-Hans-CN'),
      ),
      brand: sharedBrand(seriesA, seriesB, nodes),
      tag: sharedBrandTag(seriesA, seriesB, nodes, options),
      source: sharedSource(seriesA, seriesB, nodes),
    };

    const hasRelation = evidence.relations.length > 0;
    if (!hasRelation) continue; // 品牌/来源单独不足以提出家族
    const extras = [evidence.brand, evidence.tag, evidence.source].filter(Boolean).length;
    const hasDerivative = evidence.classes.includes('derivative');
    const hasAlternate = evidence.classes.includes('alternate');

    let state: ResolvedLink['state'];
    if (evidence.negativeRelations.length > 0) state = 'contested';
    else if (!hasDerivative && !hasAlternate && extras === 0) continue; // 纯弱关联 → 仅 related
    else if (extras >= 1) state = hasAlternate || hasDerivative ? 'provisional' : extras >= 2 ? 'provisional' : 'candidate';
    else state = 'candidate';

    links.push({ a: accumulator.a, b: accumulator.b, state, evidence });
  }

  // 家族 = Series 层上的连通分量（只连非 contested 链接）
  const franchiseUf = new UnionFind();
  for (const series of seriesList) franchiseUf.add(series.localId);
  for (const link of links) {
    if (link.state === 'contested') continue;
    franchiseUf.union(link.a, link.b);
  }
  const franchiseBuckets = new Map<number, number[]>();
  for (const series of seriesList) {
    const root = franchiseUf.find(series.localId);
    const list = franchiseBuckets.get(root) ?? [];
    list.push(series.localId);
    franchiseBuckets.set(root, list);
  }

  const franchises: ResolvedFranchise[] = [];
  for (const [root, members] of [...franchiseBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const memberLinks = links.filter(
      (link) => memberSet.has(link.a) && memberSet.has(link.b),
    );
    franchises.push({
      localId: franchises.length,
      seriesLocalIds: [...members].sort((a, b) => a - b),
      links: memberLinks,
    });
  }

  return { series: seriesList, franchises, unknownRelations };
}

/* ------------------------------------------------------------------ 辅助 */

/** 与 derived.ts 的启发式同源：去掉剧场版前缀、季度标记与标点。 */
export function heuristicKey(title: string): string | null {
  let value = (title ?? '').trim();
  if (!value) return null;
  for (const prefix of ['剧场总集篇', '剧场版', '劇場版', '剧场', '劇場', '电影', '映画', '总集篇', '総集編']) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  }
  for (const pattern of [
    /第[一二三四五六七八九十0-9]{1,3}[季期部篇]/g,
    /\b(?:season|seasons)\s*\d{1,2}\b/gi,
    /\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi,
    /\b(?:part|cour)\s*\d{1,2}\b/gi,
    /第[一二三四五六七八九十0-9]{1,3}シリーズ/g,
    /[（(]\s*(?:第\s*\d+\s*[季期]|season\s*\d+)\s*[)）]/gi,
  ]) {
    value = value.replace(pattern, ' ');
  }
  const key = value.replace(/[\s:：·・\-–—~～!！?？.,，。、'"“”‘’「」『』【】\[\]()（）]+/g, '').toLowerCase();
  return key.length >= 3 ? key : null;
}

/**
 * 锚点：只作身份对账与名称证据的参考，不等于 canonical title。
 *
 * 优先「非番外/剧场版/OVA 类」的主线作品，再按年份与 ID 取最早，
 * 避免把 OVA / 剧场版当作系列起点。
 */
function pickAnchor(ids: number[], nodes: Map<number, EngineNode>): number | null {
  if (ids.length === 0) return null;
  const sideWork = /OVA|OAD|WEB|剧场版|劇場版|电影|映画|特别篇|特別篇|总集篇|総集編|动态漫画/i;
  const mainline = ids.filter((id) => !sideWork.test(nodes.get(id)?.format ?? ''));
  const candidates = mainline.length > 0 ? mainline : ids;
  return (
    [...candidates].sort((a, b) => {
      const nodeA = nodes.get(a);
      const nodeB = nodes.get(b);
      const yearA = nodeA?.year ?? 9999;
      const yearB = nodeB?.year ?? 9999;
      if (yearA !== yearB) return yearA - yearB;
      return a - b;
    })[0] ?? null
  );
}

function seriesNodeIds(series: ResolvedSeries): number[] {
  return series.primaryIds;
}

function sharedBrand(
  a: ResolvedSeries,
  b: ResolvedSeries,
  nodes: Map<number, EngineNode>,
): string | null {
  if (a.primaryIds.length < 2 || b.primaryIds.length < 2) return null;
  const titlesA = seriesNodeIds(a)
    .map((id) => nodes.get(id))
    .filter((node): node is EngineNode => Boolean(node))
    .map(titleOf)
    .filter(Boolean);
  const titlesB = seriesNodeIds(b)
    .map((id) => nodes.get(id))
    .filter((node): node is EngineNode => Boolean(node))
    .map(titleOf)
    .filter(Boolean);
  const brandA = brandOnly(titlesA);
  const brandB = brandOnly(titlesB);
  if (!brandA || !brandB) return null;
  const compactA = brandA.replace(/\s+/g, '').toLowerCase();
  const compactB = brandB.replace(/\s+/g, '').toLowerCase();
  if (compactA.includes(compactB) || compactB.includes(compactA)) {
    return brandA.length <= brandB.length ? brandA : brandB;
  }
  return null;
}

function brandOnly(titles: string[]): string | null {
  // 轻量版本：求所有标题的最长公共前缀，并清理季度/格式尾巴
  if (titles.length < 2) return null;
  let prefix = titles[0]!;
  for (const title of titles.slice(1)) {
    let index = 0;
    const max = Math.min(prefix.length, title.length);
    while (index < max && prefix[index] === title[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  const cleaned = prefix
    .replace(/[\s:：·・\-–—~～!！?？.,，。、「」『』〈〉《》\[\]()（）/／\\×✕]+$/u, '')
    .replace(/[\s:：·・\-–—]*(?:第\s*[0-9一二三四五六七八九十]{0,3}|\d{1,3})\s*$/u, '')
    .replace(/[\s:：·・\-–—]*[的之与和]\s*$/u, '')
    .trim();
  const cjk = (cleaned.match(/[\u3400-\u9fff\u3040-\u30ff]/g) ?? []).length;
  if (cjk >= 2 || cleaned.replace(/[\s\p{P}]/gu, '').length >= 4) return cleaned;
  return null;
}

function sharedBrandTag(
  a: ResolvedSeries,
  b: ResolvedSeries,
  nodes: Map<number, EngineNode>,
  options: ResolverOptions,
): string | null {
  const tagsA = new Set<string>();
  for (const id of seriesNodeIds(a)) {
    for (const tag of nodes.get(id)?.tags ?? []) tagsA.add(tag);
  }
  if (tagsA.size === 0) return null;
  const titlesA = seriesNodeIds(a)
    .map((id) => nodes.get(id))
    .filter((node): node is EngineNode => Boolean(node))
    .map(titleOf);
  const titlesB = seriesNodeIds(b)
    .map((id) => nodes.get(id))
    .filter((node): node is EngineNode => Boolean(node))
    .map(titleOf);

  const hits: Array<{ tag: string; frequency: number }> = [];
  const seen = new Set<string>();
  for (const id of seriesNodeIds(b)) {
    for (const tag of nodes.get(id)?.tags ?? []) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      if (!tagsA.has(tag)) continue;
      if (options.isExcludedTag(tag)) continue;
      const frequency = options.tagFrequency.get(tag) ?? 0;
      if (frequency > options.rareTagLimit) continue;
      if (!isBrandLike(tag, [...titlesA, ...titlesB])) continue;
      hits.push({ tag, frequency });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((x, y) => x.frequency - y.frequency || x.tag.localeCompare(y.tag, 'zh-Hans-CN'));
  return hits[0]!.tag;
}

function isBrandLike(tag: string, titles: string[]): boolean {
  if (tag.length < 2) return false;
  if (/系列|シリーズ|project|企画|计划|プロジェクト/i.test(tag)) return true;
  const normalized = tag.toLowerCase().replace(/[\s\p{P}]/gu, '');
  const hits = titles.filter((title) =>
    title.toLowerCase().replace(/[\s\p{P}]/gu, '').includes(normalized),
  ).length;
  return hits >= 2;
}

function sharedSource(
  a: ResolvedSeries,
  b: ResolvedSeries,
  nodes: Map<number, EngineNode>,
): string | null {
  const sourcesA = new Set<string>();
  for (const id of seriesNodeIds(a)) {
    for (const token of normalizeTokens(nodes.get(id)?.originals ?? [])) sourcesA.add(token);
  }
  if (sourcesA.size === 0) return null;
  for (const id of seriesNodeIds(b)) {
    for (const token of normalizeTokens(nodes.get(id)?.originals ?? [])) {
      if (sourcesA.has(token)) return token;
    }
  }
  return null;
}
