import {
  CalendarClock,
  Clock,
  Database,
  Eye,
  Gauge,
  Hourglass,
  Layers,
  Percent,
  PieChart,
  Star,
  ThumbsUp,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { formatDuration, formatNumber, formatPercent, formatRelative, statusColorVar } from '../lib/format.js';
import { useConfig, useDashboard } from '../lib/queries.js';
import { CategoryBar, ChartSkeleton, DistributionDonut, RankedBar } from '../components/charts/generic.js';
import { ComparisonScatter, TrendArea } from '../components/charts/trend.js';
import { OnboardingCard } from '../components/OnboardingCard.js';
import { MiniSubjectRow } from '../components/subject/MiniList.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader, SectionTitle, StatCard } from '../components/ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';

export function DashboardPage() {
  const config = useConfig({ refetchOnMount: 'always', refetchOnWindowFocus: 'always' });
  const nsfwSetting = config.isFetching || !config.data ? undefined : config.data.hideNsfw === true;
  const { data, isLoading, error, refetch } = useDashboard(nsfwSetting);
  const hideNsfw = data?.hideNsfw ?? nsfwSetting;

  /**
   * 历史数据点很少时（例如刚建立数据库、只有当前年份），
   * 固定 280px 高度会留下一大片空白；这里按数据量收敛高度，
   * 既保持图表语言一致，也不会让页面出现「空框」观感。
   */
  const trendHeight = (points: number): number => (points <= 3 ? 190 : points <= 6 ? 240 : 280);

  const statusItems = useMemo(() => {
    if (!data) return [];
    const labels: Record<string, string> = {
      '1': '想看',
      '2': '看过',
      '3': '在看',
      '4': '搁置',
      '5': '抛弃',
    };
    return Object.entries(data.overview.statusCounts).map(([key, value]) => ({
      name: labels[key] ?? key,
      value,
      color: statusColorVar(Number(key)),
    }));
  }, [data]);

  if (config.error) {
    return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;
  }
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-4 xl:grid-cols-safe-6">
          {Array.from({ length: 12 }).map((_, index) => (
            <Skeleton key={index} className="h-[86px]" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-safe-2">
          <ChartSkeleton height={260} />
          <ChartSkeleton height={260} />
        </div>
      </div>
    );
  }

  const { overview, distributions, timeline, bias } = data;

  if (overview.total === 0) {
    return (
      <div className="space-y-4">
        <SectionTitle title="仪表盘" description="同步完成后，这里会显示你的收藏全貌与分析结果。" />
        <OnboardingCard />
      </div>
    );
  }

  const yearCategories = distributions.year.map((item) => item.key);
  const yearValues = distributions.year.map((item) => item.count);
  const yearAverages = distributions.year.map((item) => item.averageRate);

  return (
    <div className="space-y-5">
      <SectionTitle
        title="仪表盘"
        description={`当前可见 ${formatNumber(overview.total)} 部动画 · 上次成功同步 ${formatRelative(overview.lastSyncAt)}`}
        actions={
          <>
            <Button size="sm" onClick={() => void refetch()}>
              刷新数据
            </Button>
            <Link to="/library">
              <Button size="sm" variant="primary">
                浏览收藏库
              </Button>
            </Link>
          </>
        }
      />

      {hideNsfw ? (
        <InlineNote tone="neutral">
          当前可见口径：已隐藏的 NSFW 内容不计入本页统计（数据未被删除，可在「设置」中恢复）。
        </InlineNote>
      ) : null}

      {/*
        KPI 分三行，每行内部语义一致：
          1. 收藏状态概览（总量 + 五种状态）→ 6 列
          2. 评分与收藏完成度（完成率 / 收藏状态 / 平均评分）→ 4 列
          3. 结构类指标（集数进度 / 高分作品 / 时长估算）→ 3 列
        每行一个独立网格，避免 13 张卡片在 6 列里换行成「6 + 6 + 1」。
      */}
      <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-6">
        <StatCard label="收藏总量" value={formatNumber(overview.total)} icon={<Database size={14} />} hint="当前可见收藏" />
        <StatCard
          label="看过"
          value={formatNumber(overview.statusCounts['2'] ?? 0)}
          tone="success"
          icon={<Eye size={14} />}
          hint={formatPercent(overview.completionRate)}
        />
        <StatCard
          label="想看"
          value={formatNumber(overview.statusCounts['1'] ?? 0)}
          tone="accent"
          icon={<Layers size={14} />}
        />
        <StatCard
          label="在看"
          value={formatNumber(overview.statusCounts['3'] ?? 0)}
          tone="warning"
          icon={<Clock size={14} />}
        />
        <StatCard
          label="搁置"
          value={formatNumber(overview.statusCounts['4'] ?? 0)}
          icon={<Hourglass size={14} />}
        />
        <StatCard
          label="抛弃"
          value={formatNumber(overview.statusCounts['5'] ?? 0)}
          tone="danger"
          icon={<XCircle size={14} />}
        />
      </div>

      <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-4">
        <StatCard
          label="完成率"
          value={formatPercent(overview.completionRate)}
          icon={<Percent size={14} />}
          /* 与「看过」卡片同源：看过 / 收藏总量 */
          hint={`已看 ${formatNumber(overview.statusCounts['2'] ?? 0)} / 收藏 ${formatNumber(overview.total)}`}
        />
        <StatCard
          /* 收藏状态：主数字与辅助文字都来自 canonical collection status */
          label="收藏状态"
          value={`${formatNumber(overview.statusCounts['2'] ?? 0)} / ${formatNumber(overview.total)}`}
          icon={<PieChart size={14} />}
          hint={
            `想看 ${formatNumber(overview.statusCounts['1'] ?? 0)} · ` +
            `在看 ${formatNumber(overview.statusCounts['3'] ?? 0)} · ` +
            `搁置 ${formatNumber(overview.statusCounts['4'] ?? 0)} · ` +
            `抛弃 ${formatNumber(overview.statusCounts['5'] ?? 0)}`
          }
        />
        <StatCard
          label="平均我的评分"
          value={overview.averageRate === null ? '—' : overview.averageRate.toFixed(2)}
          icon={<Star size={14} />}
          hint={`中位数 ${overview.medianRate ?? '—'} · 已评分 ${overview.ratedCount} 部`}
        />
        <StatCard
          label="Bangumi 平均分"
          value={overview.averageBgmScore === null ? '—' : overview.averageBgmScore.toFixed(2)}
          icon={<Gauge size={14} />}
          hint={`我的评分差 ${overview.meanDelta === null ? '—' : overview.meanDelta.toFixed(2)}`}
        />
      </div>

      <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-3">
        <StatCard
          /*
           * 集数层面的统计：标题与辅助说明都必须点明「集数」与分母范围，
           * 避免被理解成「整个收藏完成了多少」。
           */
          label="已看集数进度"
          value={`${formatNumber(overview.watchedEpisodes)} / ${formatNumber(overview.totalEpisodes)} 集`}
          icon={<TrendingUp size={14} />}
          hint={`按 ${formatNumber(overview.progressCountedSubjects)} 部可计算条目的总集数统计（不含想看）`}
        />
        <StatCard
          label="高分作品（≥8）"
          value={formatNumber(overview.highRatedCount)}
          tone="success"
          icon={<ThumbsUp size={14} />}
          hint={`低分（≤5）${overview.lowRatedCount} 部`}
        />
        <StatCard
          label="估算观看时长"
          value={formatDuration(overview.estimatedMinutes)}
          icon={<CalendarClock size={14} />}
          hint="按各放送形态单集时长估算"
        />
      </div>

      {overview.detailCoverage.ratio < 1 ? (
        <InlineNote tone="neutral">
          条目详情已同步 {formatPercent(overview.detailCoverage.ratio)}（
          {overview.detailCoverage.synced}/{overview.detailCoverage.total}）。
          制作公司、放送形态等字段依赖详情数据，可以到「设置」执行「补全详情」。
        </InlineNote>
      ) : null}

      {/* 第一行：三张构成类图表等宽排列 */}
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-safe-3">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader
            className="p-0"
            title="收藏状态分布"
            description="看过 / 想看 / 在看 / 搁置 / 抛弃"
          />
          <DistributionDonut
            items={statusItems}
            centerLabel="总收藏"
            centerValue={formatNumber(overview.total)}
          />
        </Card>

        <Card className="px-4 pb-3 pt-4">
          <CardHeader className="p-0" title="我的评分分布" description="含未评分作品" />
          <CategoryBar
            categories={distributions.rate.map((item) => item.label)}
            values={distributions.rate.map((item) => item.count)}
            color="var(--chart-2)"
          />
        </Card>

        <Card className="px-4 pb-3 pt-4">
          <CardHeader className="p-0" title="放送形态分布" description="按 Bangumi 条目的放送形态归类" />
          <DistributionDonut
            items={distributions.format.map((item, index) => ({
              name: item.label,
              value: item.count,
              color: `var(--chart-${(index % 8) + 1})`,
            }))}
            centerLabel="条目数"
            centerValue={formatNumber(overview.total)}
          />
        </Card>

      </div>

      {/* 趋势类图表：年份分布与收藏曲线各占一行，避免宽窄不齐留下空位 */}
      <div className="grid gap-3 sm:gap-4">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader
            className="p-0"
            title="动画年份分布"
            description="柱状为数量，折线为该年份作品的平均我的评分"
          />
          <CategoryBar
            categories={yearCategories}
            values={yearValues}
            averageValues={yearAverages}
            rotation={yearCategories.length > 20 ? 45 : 0}
            height={yearCategories.length <= 3 ? 200 : 280}
          />
        </Card>

        <Card className="px-4 pb-3 pt-4">
          <CardHeader
            className="p-0"
            title="收藏数量随时间变化"
            description={timeline.note}
          />
          <TrendArea
            categories={timeline.points.map((point) => point.period)}
            series={[
              { name: '累计收藏', data: timeline.points.map((point) => point.total), area: true },
              { name: '当年变动', data: timeline.points.map((point) => point.added), area: false },
              {
                name: '当年完成',
                data: timeline.points.map((point) => point.updated),
                area: false,
                color: 'var(--chart-2)',
              },
            ]}
            height={trendHeight(timeline.points.length)}
          />
        </Card>
      </div>

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-safe-2">
        <Card className="px-4 pb-3 pt-4">
          <CardHeader className="p-0" title="我的评分趋势" description="按最后更新年份统计" />
          <CategoryBar
            categories={timeline.points.map((point) => point.period)}
            values={timeline.points.map((point) => point.added)}
            averageValues={timeline.points.map((point) => point.averageRate)}
            height={trendHeight(timeline.points.length)}
          />
        </Card>

        <Card className="px-4 pb-3 pt-4">
          <CardHeader className="p-0" title="标签分布" description="出现最多的公共标签（Top 12）" />
          <RankedBar
            items={distributions.tag.slice(0, 12).map((item) => ({
              name: item.label,
              value: item.count,
            }))}
            height={280}
          />
        </Card>
      </div>

      <Card className="px-4 pb-3 pt-4">
        <CardHeader
          className="p-0"
          title="我的评分 vs Bangumi 平均分"
          description={`共 ${bias.count} 部可比较作品 · 平均差 ${bias.meanDelta ?? '—'} 分 · 越靠左上代表你越喜欢`}
          actions={
            <Link to="/analysis">
              <Button size="sm" variant="ghost">
                查看偏差明细
              </Button>
            </Link>
          }
        />
        {bias.scatter.length > 0 ? (
          <ComparisonScatter points={bias.scatter} height={340} />
        ) : (
          <EmptyState title="还没有可比较的评分" description="为作品打分后会生成评分对比图。" />
        )}
      </Card>

      {/* 最近动态：三张列表等高对齐 */}
      <div className="grid gap-4 lg:grid-cols-safe-3">
        <Card>
          <CardHeader title="最近修改" description="按 Bangumi 最后更新时间排序" />
          <CardBody className="pt-1">
            <div className="flex flex-col">
              {data.recentlyUpdated.map((item) => (
                <MiniSubjectRow key={item.id} item={item} meta="updated" />
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="最近观看进度" description="正在观看的作品与当前进度" />
          <CardBody className="pt-1">
            {data.inProgress.length > 0 ? (
              <div className="flex flex-col">
                {data.inProgress.map((item) => (
                  <MiniSubjectRow key={item.id} item={item} showProgress />
                ))}
              </div>
            ) : (
              <EmptyState
                title="当前没有「在看」的作品"
                description="在 Bangumi 上把作品标记为在看，同步后就会出现在这里。"
                className="py-6"
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="最近新增" description="本工具首次记录到的作品" />
          <CardBody className="pt-1">
            <div className="flex flex-col">
              {data.recentlyAdded.map((item) => (
                <MiniSubjectRow key={item.id} item={item} meta="added" />
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
