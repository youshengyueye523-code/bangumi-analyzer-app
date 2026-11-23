import type { MouseEvent } from 'react';
import type { EntityAnalysis } from '@bangumi-analyzer/shared';
import { formatDelta, formatDuration, formatNumber, formatPercent, formatRate, statusLabel } from '../../lib/format.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { InlineNote } from '../ui/feedback.js';
import { MetricValue } from './MetricValue.js';

const STATUS_KEYS = ['2', '1', '3', '4', '5'] as const;

/**
 * v1.8 Entity Analysis B–E 层（两个详情页共用）。
 * 语义来自 frozen IA：B 概览 / C 评分组 / D 放送事实 / E 消费证据。
 * F（证据下钻）复用现有成员列表，不在本组件内重新实现成员浏览器。
 */

export function PersonalOverviewSection({
  analysis,
  scope,
}: {
  analysis: EntityAnalysis;
  scope: 'series' | 'franchise';
}) {
  const { coverage, completion, statusStructure } = analysis;
  return (
    <Card>
      <CardHeader
        title={scope === 'series' ? '我与这个系列的关系' : '我与这个家族的关系'}
        description={
          scope === 'series'
            ? '只统计 primary 成员；relation-only 成员只进入覆盖率分母'
            : '跨 Series 聚合：成员是系列，计数单位是系列内的作品；候选成员不计入'
        }
      />
      <CardBody className="space-y-4 pt-2">
        <div className="grid gap-4 sm:grid-cols-safe-2">
          <div>
            <p className="text-caption text-subtle">覆盖率（Entity Coverage）</p>
            <MetricValue
              value={coverage.value}
              format={(value) => formatPercent(value)}
              sample={coverage.knownMembers}
              note={`已知 ${coverage.knownMembers} 部 · 我的收藏 ${coverage.localCollected} 部${
                coverage.relationOnly > 0 ? ` · 其中 ${coverage.relationOnly} 部仅由关系数据得知` : ''
              }`}
            />
          </div>
          <div>
            <p className="text-caption text-subtle">完成度（member 级）</p>
            <MetricValue
              value={completion.value}
              format={(value) => formatPercent(value)}
              sample={completion.collectedCount}
              note={`看过 ${completion.watched} / 收藏 ${completion.collectedCount} 部`}
            />
            {completion.collectedCount > 0 ? (
              <div className="mt-1">
                {completion.watched === completion.collectedCount ? (
                  <span className="text-caption text-success">已全部看过</span>
                ) : completion.watched === 0 ? (
                  <span className="text-caption text-warning">尚未看过任何一部</span>
                ) : (
                  <span className="text-caption text-subtle">尚未全部看过</span>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <p className="text-caption text-subtle">状态结构（distribution-only）</p>
          {statusStructure.available ? (
            <div className="mt-1 grid grid-cols-safe-2 gap-1.5 sm:grid-cols-safe-5">
              {STATUS_KEYS.map((key) => (
                <div
                  key={key}
                  data-status={key}
                  className="rounded-[10px] border border-border bg-surface-2 px-2.5 py-1.5"
                >
                  <p className="text-caption text-subtle">{statusLabel(Number(key))}</p>
                  <p className="numeric text-body">{statusStructure.counts[key]}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-note text-subtle">无收藏成员 · 状态结构不可用（不是「全 0」）</p>
          )}
          <p className="mt-1 text-caption text-subtle">
            完成度是「收藏成员中看过的比例」，不是集数进度；状态结构不参与排序。
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

export interface RatingSampleItem {
  id: number;
  title: string;
  myRate: number;
  bgmScore: number | null;
  delta: number | null;
}

export function RatingProfileSection({
  analysis,
  samples = [],
  onMemberClick,
}: {
  analysis: EntityAnalysis;
  samples?: RatingSampleItem[];
  /** v1.8.1：点击评分样本时由页面统一处理锚点定位（保留 href 供复制 / 中键） */
  onMemberClick?: (event: MouseEvent, subjectId: number) => void;
}) {
  const { average, coverage, delta } = analysis.rating;
  return (
    <Card>
      <CardHeader
        title="我对它的评价"
        description="平均分 / 评分覆盖 / 评分差值必须一起读：先看样本，再看数字"
      />
      <CardBody className="space-y-4 pt-2">
        <div className="grid gap-4 sm:grid-cols-safe-3">
          <div>
            <p className="text-caption text-subtle">我的平均分</p>
            <MetricValue
              value={average.value}
              format={(value) => formatRate(value, 2)}
              sample={average.ratedCount}
              note="已评分成员的平均分（不加权）"
            />
          </div>
          <div>
            <p className="text-caption text-subtle">评分覆盖</p>
            <MetricValue
              value={coverage.value}
              format={(value) => formatPercent(value)}
              sample={coverage.collectedCount}
              note={`已评分 ${coverage.ratedCount} / 收藏 ${coverage.collectedCount} 部`}
            />
          </div>
          <div>
            <p className="text-caption text-subtle">评分差值</p>
            <MetricValue
              value={delta.value}
              format={(value) => formatDelta(value)}
              sample={delta.pairedCount}
              note="我的评分 − Bangumi 评分（逐条差值的平均）"
            />
          </div>
        </div>

        {samples.length > 0 ? (
          <div>
            <p className="text-caption text-subtle">
              评分样本（前 {Math.min(samples.length, 8)} 条 · 完整样本见下方成员列表）
            </p>
            <div className="mt-1 space-y-1">
              {samples.slice(0, 8).map((sample) => (
                <div
                  key={sample.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-[10px] border border-border bg-surface-2 px-3 py-1.5"
                >
                  <a
                    href={`#member-${sample.id}`}
                    onClick={onMemberClick ? (event) => onMemberClick(event, sample.id) : undefined}
                    className="min-w-0 flex-1 truncate text-note transition-colors hover:text-accent"
                  >
                    {sample.title}
                  </a>
                  <span className="numeric text-caption text-subtle">
                    我的 {sample.myRate} · 大众 {formatRate(sample.bgmScore, 1)} · 差{' '}
                    {formatDelta(sample.delta)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <InlineNote tone="neutral">
            当前没有可展示的评分样本：需要成员同时具备「我的评分」与 Bangumi 评分。
          </InlineNote>
        )}
      </CardBody>
    </Card>
  );
}

export function AirTimelineSection({ analysis }: { analysis: EntityAnalysis }) {
  const { span, distribution } = analysis.air;
  const maxCount = Math.max(1, ...distribution.years.map((entry) => entry.count));
  return (
    <Card>
      <CardHeader
        title="放送时间形状"
        description="只使用作品放送事实（成员年份），与我的收藏时间无关"
      />
      <CardBody className="space-y-3 pt-2">
        <div>
          <p className="text-caption text-subtle">放送跨度</p>
          {span.firstYear !== null && span.lastYear !== null ? (
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="numeric text-section font-semibold">
                {span.firstYear} – {span.lastYear}
              </span>
              <span className="text-caption text-subtle">
                基于 {span.datedMembers} 个有年份的成员（共 {span.totalMembers} 部）
              </span>
            </div>
          ) : (
            <p className="text-note text-subtle">— 无放送年份数据</p>
          )}
        </div>

        {distribution.years.length > 0 ? (
          <div className="space-y-1">
            {distribution.years.map((entry) => (
              <div key={entry.year} className="flex items-center gap-2">
                <span className="w-12 shrink-0 numeric text-caption text-subtle">{entry.year}</span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${(entry.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right numeric text-caption text-subtle">
                  {entry.count}
                </span>
              </div>
            ))}
            <p className="text-caption text-subtle">
              覆盖 {distribution.datedMembers} / {distribution.totalMembers} 部；没有年份数据的成员不参与分布。
            </p>
          </div>
        ) : (
          <p className="text-note text-subtle">— 无年份分布数据</p>
        )}
      </CardBody>
    </Card>
  );
}

export function ConsumptionEvidenceSection({ analysis }: { analysis: EntityAnalysis }) {
  const { watchedMembers, watchedEpisodes, estimatedWatchTime } = analysis.consumption;
  return (
    <Card>
      <CardHeader
        title="消费证据"
        description="三个独立量，各自成立；不合成「投入分」"
      />
      <CardBody className="grid gap-4 pt-2 sm:grid-cols-safe-3">
        <div>
          <p className="text-caption text-subtle">看过成员</p>
          <MetricValue
            value={watchedMembers}
            format={(value) => `${formatNumber(value)} 部`}
            note="原始计数（收藏状态 = 看过）"
          />
        </div>
        <div>
          <p className="text-caption text-subtle">已看集数</p>
          <MetricValue
            value={watchedEpisodes}
            format={(value) => `${formatNumber(value)} 集`}
            note="看过记全部集数；其它状态取观看进度"
          />
        </div>
        <div>
          <p className="text-caption text-subtle">估算观看时长</p>
          <MetricValue
            value={estimatedWatchTime.minutes}
            format={(value) => formatDuration(value)}
            estimate
            sample={estimatedWatchTime.contributingMembers}
            note={`按放送形态单集时长估算${
              estimatedWatchTime.excludedNoEpisodeData > 0
                ? ` · ${estimatedWatchTime.excludedNoEpisodeData} 个成员缺少集数数据`
                : ''
            }`}
          />
        </div>
      </CardBody>
    </Card>
  );
}
