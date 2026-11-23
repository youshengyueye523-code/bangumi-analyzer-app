import { TimelineSection } from '../components/timeline/TimelineSection.js';
import { Link, useSearchParams } from 'react-router-dom';
import { CategoryBar, DistributionDonut, RankedBar } from '../components/charts/generic.js';
import { ComparisonScatter, QuarterHeatmap } from '../components/charts/trend.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader, SectionTitle } from '../components/ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';

import { TabContent, TabList, TabTrigger, Tabs } from '../components/ui/tabs.js';
import { formatDelta, formatNumber, formatPercent, formatRate } from '../lib/format.js';
import {
  useBias,
  useDirectors,
  useDistributions,
  useHabits,
  useStudios,
} from '../lib/queries.js';

function RankTable({
  rows,
  nameLabel,
  emptyText,
}: {
  rows: Array<{
    name: string;
    total: number;
    averageRate: number | null;
    averageBgmScore: number | null;
    highRatedShare: number | null;
    averageDelta: number | null;
  }>;
  nameLabel: string;
  emptyText: string;
}) {
  if (rows.length === 0) return <InlineNote tone="neutral">{emptyText}</InlineNote>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-note">
        <thead>
          <tr className="border-b border-border text-left text-caption text-subtle">
            <th className="py-2 pr-3 font-medium">{nameLabel}</th>
            <th className="py-2 pr-3 text-right font-medium">作品数</th>
            <th className="py-2 pr-3 text-right font-medium">平均我的评分</th>
            <th className="py-2 pr-3 text-right font-medium">平均大众评分</th>
            <th className="py-2 pr-3 text-right font-medium">高分比例</th>
            <th className="py-2 text-right font-medium">平均差</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-border/70 last:border-b-0 hover:bg-surface-2">
              <td className="max-w-[220px] truncate py-2 pr-3" title={row.name}>
                {row.name}
              </td>
              <td className="py-2 pr-3 text-right numeric">{row.total}</td>
              <td className="py-2 pr-3 text-right numeric">{formatRate(row.averageRate, 2)}</td>
              <td className="py-2 pr-3 text-right numeric text-muted">
                {formatRate(row.averageBgmScore, 2)}
              </td>
              <td className="py-2 pr-3 text-right numeric">{formatPercent(row.highRatedShare, 0)}</td>
              <td
                className={
                  row.averageDelta === null
                    ? 'py-2 text-right numeric text-subtle'
                    : row.averageDelta > 0
                      ? 'py-2 text-right numeric text-success'
                      : 'py-2 text-right numeric text-danger'
                }
              >
                {formatDelta(row.averageDelta)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreferenceSection() {
  const { data, isLoading, error } = useDistributions();
  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Skeleton className="h-[320px]" />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader title="放送形态分布" description="我的收藏以哪种形态为主" />
          <DistributionDonut
            items={data.format.map((item, index) => ({
              name: item.label,
              value: item.count,
              color: `var(--chart-${(index % 8) + 1})`,
            }))}
            height={260}
            centerLabel="作品"
            centerValue={formatNumber(data.format.reduce((sum, item) => sum + item.count, 0))}
          />
        </Card>
        <Card className="px-4 pb-3 pt-4">
          <CardHeader
            title="形态偏好对比"
            description="各形态的平均我的评分（0-10）与作品数量"
          />
          <CategoryBar
            categories={data.format.map((item) => item.label)}
            values={data.format.map((item) => item.count)}
            averageValues={data.format.map((item) => item.averageRate)}
            height={260}
          />
        </Card>
      </div>

      <Card>
        <CardHeader title="类型偏好明细" description="高分比例 = 该分类中我给 ≥8 分的比例" />
        <CardBody className="pt-2">
          <RankTable
            rows={data.format.map((item) => ({
              name: `${item.label}（占 ${formatPercent(item.share, 0)}）`,
              total: item.count,
              averageRate: item.averageRate,
              averageBgmScore: item.averageBgmScore,
              highRatedShare: item.highRatedShare,
              averageDelta:
                item.averageRate !== null && item.averageBgmScore !== null
                  ? Number((item.averageRate - item.averageBgmScore).toFixed(2))
                  : null,
            }))}
            nameLabel="放送形态"
            emptyText="暂无放送形态数据。"
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader title="标签排行" description="出现次数最多的公共标签" />
          <RankedBar
            items={data.tag.slice(0, 15).map((item) => ({ name: item.label, value: item.count }))}
            height={360}
            maxItems={15}
          />
        </Card>
        <Card className="px-4 pb-3 pt-4">
          <CardHeader title="标签平均评分" description="按平均我的评分排序（作品数 ≥3）" />
          <RankedBar
            items={data.tag
              .filter((item) => item.count >= 3 && item.averageRate !== null)
              .sort((a, b) => (b.averageRate ?? 0) - (a.averageRate ?? 0))
              .slice(0, 15)
              .map((item) => ({ name: item.label, value: Number((item.averageRate ?? 0).toFixed(2)) }))}
            height={360}
            maxItems={15}
            valueFormatter={(item) => `${item.value.toFixed(2)} 分`}
          />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card>
          <CardHeader title="原作类型分布" description="来自条目 infobox 的「原作」字段" />
          <CardBody className="pt-2">
            {data.original.length > 0 ? (
              <RankTable
                rows={data.original.map((item) => ({
                  name: item.label,
                  total: item.count,
                  averageRate: item.averageRate,
                  averageBgmScore: item.averageBgmScore,
                  highRatedShare: item.highRatedShare,
                  averageDelta: null,
                }))}
                nameLabel="原作类型"
                emptyText="暂无原作类型数据。"
              />
            ) : (
              <InlineNote tone="neutral">
                暂无原作类型数据：需要在「设置」中执行「补全详情」，从条目详情里解析 infobox。
              </InlineNote>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="季度分布" description="按播出季度统计收藏量" />
          <CardBody className="pt-2">
            <RankTable
              rows={data.season.map((item) => ({
                name: item.label,
                total: item.count,
                averageRate: item.averageRate,
                averageBgmScore: item.averageBgmScore,
                highRatedShare: item.highRatedShare,
                averageDelta: null,
              }))}
              nameLabel="季度"
              emptyText="暂无季度数据。"
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function StudioSection() {
  const { data: studios, isLoading, error } = useStudios(40);
  const { data: directors } = useDirectors(40);

  if (error) return <ErrorState error={error} />;
  if (isLoading || !studios) return <Skeleton className="h-[320px]" />;

  return (
    <div className="space-y-4">
      <InlineNote tone="neutral">
        制作公司与导演数据来自条目 infobox（本地解析）与 Bangumi 官方人员接口。
        执行「深度同步」可以显著提升覆盖率与准确性。
      </InlineNote>

      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader title="我看得最多的制作公司" />
          <RankedBar
            items={studios.items
              .slice()
              .sort((a, b) => b.total - a.total)
              .slice(0, 12)
              .map((item) => ({ name: item.name, value: item.total }))}
            height={340}
          />
        </Card>
        <Card className="px-4 pb-3 pt-4">
          <CardHeader title="制作公司平均评分" description="已评分作品 ≥3 部" />
          <RankedBar
            items={studios.items
              .filter((item) => item.rated >= 3 && item.averageRate !== null)
              .sort((a, b) => (b.averageRate ?? 0) - (a.averageRate ?? 0))
              .slice(0, 12)
              .map((item) => ({ name: item.name, value: Number((item.averageRate ?? 0).toFixed(2)) }))}
            height={340}
            valueFormatter={(item) => `${item.value.toFixed(2)} 分`}
          />
        </Card>
      </div>

      <Card>
        <CardHeader title="制作公司明细" description="作品数 / 平均评分 / 高分比例 / 平均评分差" />
        <CardBody className="pt-2">
          <RankTable rows={studios.items} nameLabel="制作公司" emptyText="暂无制作公司数据。" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="导演明细" description="同样口径统计导演维度" />
        <CardBody className="pt-2">
          <RankTable
            rows={directors?.items ?? []}
            nameLabel="导演"
            emptyText="暂无导演数据：可以执行「深度同步」抓取官方人员数据。"
          />
        </CardBody>
      </Card>
    </div>
  );
}

function BiasSection() {
  const { data, isLoading, error } = useBias(20);
  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Skeleton className="h-[320px]" />;
  if (data.count === 0) {
    return (
      <EmptyState
        title="还没有可比较的评分"
        description="为作品打分（且该条目在 Bangumi 上也有评分）后，这里会显示你与大众的评分差异。"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-safe-2 gap-3 lg:grid-cols-safe-4">
        {[
          { label: '可比较作品', value: formatNumber(data.count) },
          { label: '平均评分差', value: formatDelta(data.meanDelta) },
          { label: '我更喜欢', value: formatNumber(data.overratedCount) },
          { label: '我更不喜欢', value: formatNumber(data.underratedCount) },
        ].map((item) => (
          <div key={item.label} className="card-surface px-4 py-3">
            <p className="text-caption text-subtle">{item.label}</p>
            <p className="mt-1 text-title font-semibold numeric">{item.value}</p>
          </div>
        ))}
      </div>

      <Card className="px-4 pb-3 pt-4">
        <CardHeader
          title="评分散点分布"
          description="对角线代表评分完全一致；左上 = 我的评分高于大众"
        />
        <ComparisonScatter points={data.scatter} height={360} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card>
          <CardHeader title="我特别喜欢、大众评分一般" description="我的评分 − 大众评分 差值最大" />
          <CardBody className="pt-2">
            <div className="space-y-1.5">
              {data.over.map((item) => (
                <Link
                  key={item.id}
                  to={`/subjects/${item.id}`}
                  className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong"
                >
                  <span className="min-w-0 truncate text-note">{item.nameCn || item.name}</span>
                  <span className="shrink-0 text-caption numeric text-subtle">
                    我 {item.myRate} · 大众 {formatRate(item.bgmScore, 1)}
                    <span className="ml-2 font-medium text-success">+{item.delta.toFixed(2)}</span>
                  </span>
                </Link>
              ))}
              {data.over.length === 0 ? (
                <InlineNote tone="neutral">没有明显高于大众评分的作品。</InlineNote>
              ) : null}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="我不太认同、大众评分较高" description="差值最小的作品" />
          <CardBody className="pt-2">
            <div className="space-y-1.5">
              {data.under.map((item) => (
                <Link
                  key={item.id}
                  to={`/subjects/${item.id}`}
                  className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong"
                >
                  <span className="min-w-0 truncate text-note">{item.nameCn || item.name}</span>
                  <span className="shrink-0 text-caption numeric text-subtle">
                    我 {item.myRate} · 大众 {formatRate(item.bgmScore, 1)}
                    <span className="ml-2 font-medium text-danger">{item.delta.toFixed(2)}</span>
                  </span>
                </Link>
              ))}
              {data.under.length === 0 ? (
                <InlineNote tone="neutral">没有明显低于大众评分的作品。</InlineNote>
              ) : null}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function HabitsSection() {
  const { data, isLoading, error } = useHabits();
  if (error) return <ErrorState error={error} />;
  if (isLoading || !data) return <Skeleton className="h-[320px]" />;

  const years = [...new Set(data.heatmap.map((entry) => entry.year))].sort();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-safe-2 gap-3 lg:grid-cols-safe-4">
        {[
          { label: '活跃年份', value: `${data.activeYears} 年` },
          { label: '平均每年收藏', value: data.averagePerYear === null ? '—' : `${data.averagePerYear} 部` },
          {
            label: '最活跃年份',
            value: data.busiestYear ? `${data.busiestYear.year}（${data.busiestYear.count} 部）` : '—',
          },
          {
            label: '最活跃季度',
            value: data.busiestQuarter
              ? `${data.busiestQuarter.year} Q${data.busiestQuarter.quarter}`
              : '—',
          },
        ].map((item) => (
          <div key={item.label} className="card-surface px-4 py-3">
            <p className="text-caption text-subtle">{item.label}</p>
            <p className="numeric mt-1 text-section">{item.value}</p>
          </div>
        ))}
      </div>

      {/* 多列栅格统一用 minmax(0,…)：避免内部不换行内容把列撑宽（见 styles.css 的说明） */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader title="年份 × 季度观看热力图" description="颜色越深代表该季度收藏变动越多" />
          <QuarterHeatmap data={data.heatmap} years={years} height={Math.max(220, years.length * 26)} />
        </Card>
        <div className="space-y-4">
          <Card className="px-4 pb-3 pt-4">
            <CardHeader title="一周内的收藏变动分布" description="按 Bangumi 记录的最后更新时间" />
            <CategoryBar
              categories={data.weekdayDistribution.map((day) => day.label)}
              values={data.weekdayDistribution.map((day) => day.count)}
              height={220}
              color="var(--chart-5)"
            />
          </Card>
          <Card>
            <CardHeader title="观看节奏" />
            <CardBody className="pt-2 text-note">
              <div className="flex justify-between border-b border-border py-1.5">
                <span className="text-subtle">平均观看进度</span>
                <span className="numeric">{formatPercent(data.averageProgress)}</span>
              </div>
              <div className="flex justify-between border-b border-border py-1.5">
                <span className="text-subtle">平均每年观看集数</span>
                <span className="numeric">{data.averageEpisodesPerYear ?? '—'} 集</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-subtle">覆盖时间跨度</span>
                <span className="numeric">{data.spanYears} 年</span>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function AnalysisPage() {
  // 标签页状态放在 URL 上：刷新/分享链接后仍停留在同一个分析视图
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'timeline';
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'timeline') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className={`space-y-5 ${tab === 'timeline' ? 'timeline-analysis-page' : ''}`}>
      <SectionTitle
        title="统计分析"
        description="统计使用完整收藏，包括主动隐藏与 NSFW 作品；各图表仍按自己的状态、时间和评分样本规则计算。"
        actions={
          <Link to="/profile">
            <Button size="sm" variant="primary">
              查看我的画像
            </Button>
          </Link>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <TabTrigger value="timeline">年度趋势</TabTrigger>
          <TabTrigger value="preference">类型与标签</TabTrigger>
          <TabTrigger value="studio">制作公司与导演</TabTrigger>
          <TabTrigger value="bias">评分偏差</TabTrigger>
          <TabTrigger value="habits">观看习惯</TabTrigger>
        </TabList>
        <TabContent value="timeline">
          <TimelineSection />
        </TabContent>
        <TabContent value="preference">
          <PreferenceSection />
        </TabContent>
        <TabContent value="studio">
          <StudioSection />
        </TabContent>
        <TabContent value="bias">
          <BiasSection />
        </TabContent>
        <TabContent value="habits">
          <HabitsSection />
        </TabContent>
      </Tabs>
    </div>
  );
}
