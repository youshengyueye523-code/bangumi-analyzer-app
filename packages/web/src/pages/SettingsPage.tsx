import {
  BadgeCheck,
  Clock,
  Database,
  EyeOff,
  Gauge,
  KeyRound,
  LogOut,
  Palette,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { HiddenWorksCard } from '../components/settings/HiddenWorksCard.js';
import { DataManagementCard } from '../components/settings/DataManagementCard.js';
import { AiSettingsCard } from '../components/settings/AiSettingsCard.js';
import { TranslationSettingsCard } from '../components/settings/TranslationSettingsCard.js';
import { ThemeToggle } from '../components/layout/ThemeToggle.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader, SectionTitle } from '../components/ui/card.js';
import { ErrorState, InlineNote, ProgressBar, Skeleton } from '../components/ui/feedback.js';
import { Field, Input, Segmented, Switch } from '../components/ui/form.js';
import { WallpaperSettingsCard } from '../components/settings/WallpaperSettingsCard.js';
import { MaterialSettingsCard } from '../components/settings/MaterialSettingsCard.js';
import { TabContent, TabList, Tabs, TabTrigger } from '../components/ui/tabs.js';
import { Dialog } from '../components/ui/overlay.js';
import { ApiRequestError, api } from '../lib/api.js';
import {
  formatDateTime,
  formatEta,
  formatNumber,
  formatRelative,
  statusLabel,
} from '../lib/format.js';
import { queryKeys, useConfig, useLocalProfile, useSyncController } from '../lib/queries.js';
import { useToast } from '../components/ui/toast.js';

const TABS = [
  { value: 'bangumi', label: 'Bangumi' },
  // 该分区同时包含「画像 AI」与「简介翻译」两类 AI 功能（共用同一套接口配置），
  // 因此按领域命名为 AI，与 Bangumi / 外观 / 数据管理 / 关于 保持同一套命名方式
  { value: 'ai', label: 'AI' },
  { value: 'appearance', label: '外观' },
  { value: 'data', label: '数据管理' },
  { value: 'about', label: '关于' },
] as const;

type SettingsTab = (typeof TABS)[number]['value'];

const PHASE_LABEL: Record<string, string> = {
  idle: '空闲',
  preparing: '准备中',
  collections: '获取收藏列表',
  applying: '写入本地数据库',
  enriching: '补充条目详情',
  relations: '抓取系列关系',
  persons: '抓取制作人员',
  series: '计算系列分组',
  finalizing: '保存同步结果',
  done: '同步完成',
  error: '同步失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

function CredentialsCard() {
  const { data, isLoading } = useConfig();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [busy, setBusy] = useState<'save' | 'verify' | 'disconnect' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setUsername(data.username);
    setUserAgent(data.userAgent);
  }, [data]);

  useEffect(() => { setVerifyResult(null); }, [data?.username, data?.tokenHint]);

  if (isLoading || !data) return <Skeleton className="h-[260px]" />;

  async function save({ token: tokenValue }: { token?: string } = {}) {
    setBusy('save');
    try {
      const updated = await api.updateConfig({
        username: username.trim(),
        userAgent: userAgent.trim(),
        ...(tokenValue !== undefined ? { token: tokenValue } : {}),
      });
      queryClient.setQueryData(queryKeys.config, updated);
      setToken('');
      toast.push({ tone: 'success', title: '配置已保存' });
    } catch (error) {
      toast.push({
        tone: 'error',
        title: '保存失败',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy('disconnect');
    try {
      const updated = await api.disconnectBangumi();
      await queryClient.cancelQueries({ queryKey: queryKeys.config });
      queryClient.setQueryData(queryKeys.config, updated);
      setUsername(''); setToken(''); setVerifyResult(null); setConfirmDisconnect(false);
      await queryClient.invalidateQueries({ predicate: query => ['localProfile', 'syncStatus', 'syncHistory', 'health'].includes(String(query.queryKey[0])) });
      toast.push({ tone: 'success', title: '已断开 Bangumi 账号', description: '本机用户名和 Token 已清除；本地数据及 AI 配置保留。' });
    } catch (error) {
      toast.push({ tone: 'error', title: '断开失败', description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader
        title="Bangumi 账号与凭据"
        description="Token 只保存在本机 data/config.json（已加入 .gitignore），不会出现在日志、导出文件或浏览器端。"
        actions={
          data.canDisconnectBangumi && !data.username ? <Badge tone="neutral">未绑定 Bangumi 账号</Badge> : data.hasToken ? (
            <Badge tone="success">
              <BadgeCheck size={10} /> Token 已配置
            </Badge>
          ) : (
            <Badge tone="warning">未配置 Token</Badge>
          )
        }
      />
      <CardBody className="space-y-4 pt-2">
        <div className="grid gap-4 md:grid-cols-safe-2">
          <Field
            label="Bangumi 用户名（或数字 UID）"
            htmlFor="username"
            hint="个人主页地址中的那一段，例如 https://bgm.tv/user/sai 中的 sai。"
          >
            <Input
              id="username"
              value={username}
              placeholder="例如 sai"
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>

          <Field
            label="Access Token"
            htmlFor="token"
            hint={
              data.tokenHint
                ? `当前：${data.tokenHint}（留空表示不修改）`
                : '在 https://next.bgm.tv/demo/access-token 生成；不配置时只能同步公开收藏。'
            }
          >
            <Input
              id="token"
              type="password"
              value={token}
              autoComplete="off"
              placeholder={data.hasToken ? '留空则保持不变' : '粘贴 Access Token'}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="User-Agent"
          htmlFor="userAgent"
          hint="Bangumi 要求非浏览器使用者提供可识别的 UA，建议包含应用名与联系方式或项目地址。"
        >
          <Input
            id="userAgent"
            value={userAgent}
            onChange={(event) => setUserAgent(event.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<Save size={14} />}
            loading={busy === 'save'}
            disabled={busy !== null}
            onClick={() => void save(token ? { token } : {})}
          >
            保存配置
          </Button>
          <Button
            icon={<KeyRound size={14} />}
            loading={busy === 'verify'}
            disabled={busy !== null}
            onClick={async () => {
              setBusy('verify');
              try {
                const result = await api.verifyCredentials();
                setVerifyResult(result.message);
                toast.push({
                  tone: result.ok ? 'success' : 'warning',
                  title: result.ok ? '凭据有效' : '凭据不可用',
                  description: result.message,
                });
              } catch (error) {
                toast.push({ tone: 'error', title: '验证失败', description: error instanceof Error ? error.message : String(error) });
              } finally {
                setBusy(null);
              }
            }}
          >
            验证 Token
          </Button>
          {data.hasToken ? (
            <Button
              variant="ghost"
              icon={<RefreshCw size={14} />}
              disabled={busy !== null}
              onClick={() => void save({ token: '' })}
            >
              清除 Token
            </Button>
          ) : null}
          {data.canDisconnectBangumi && (data.username || data.hasToken) ? (
            <Button variant="ghost" icon={<LogOut size={14} />} disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}>
              断开 Bangumi 账号
            </Button>
          ) : null}
        </div>
        {data.canDisconnectBangumi ? <InlineNote tone="neutral">
          {data.username ? '断开账号会停止同步并清除本机用户名和 Token，不删除本地数据或 AI 配置。' : '当前未绑定账号，本地数据仍可离线使用。'}
          {' '}已有数据库保留原账号归属；重新绑定需核对原 UID，其他账号请使用全新的解压目录。
        </InlineNote> : null}
        {verifyResult ? <InlineNote tone="neutral">{verifyResult}</InlineNote> : null}
        <Dialog open={confirmDisconnect} onOpenChange={open => { if (busy !== 'disconnect') setConfirmDisconnect(open); }}
          title="断开 Bangumi 账号？" description="停止并等待当前同步结束，然后清除本机 Bangumi 用户名和 Access Token。"
          footer={<><Button disabled={busy === 'disconnect'} onClick={() => setConfirmDisconnect(false)}>取消</Button>
            <Button variant="primary" loading={busy === 'disconnect'} disabled={busy === 'disconnect'} onClick={() => void disconnect()}>确认断开</Button></>}>
          <p className="text-note text-muted">收藏、评分、人工治理、历史分析、备份和独立 AI 配置全部保留，数据库仍属于原账号。此操作不注销 Bangumi 网站账号，也不撤销远端令牌。</p>
        </Dialog>
      </CardBody>
    </Card>
  );
}

function SyncPreferencesCard() {
  const { data, isLoading } = useConfig();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<AppConfigPublic>>({});
  const [saving, setSaving] = useState(false);

  if (isLoading || !data) return <Skeleton className="h-[240px]" />;

  const value = { ...data, ...draft };

  return (
    <Card>
      <CardHeader title="同步选项" description="这些设置直接影响同步速度与接口压力" />
      <CardBody className="space-y-4 pt-2">
        <div className="grid gap-4 md:grid-cols-safe-2">
          <Field label="同步的条目类型" hint="本工具聚焦动画；如需同时保存其它类型可切换为「全部类型」。">
            <Segmented
              value={value.subjectTypes.length > 1 ? 'all' : 'anime'}
              options={[
                { value: 'anime', label: '仅动画' },
                { value: 'all', label: '全部类型' },
              ]}
              onChange={(next) =>
                setDraft((prev) => ({
                  ...prev,
                  subjectTypes: next === 'anime' ? [2] : [1, 2, 3, 4, 6],
                }))
              }
            />
          </Field>

          <Field
            label="请求间隔（毫秒）"
            htmlFor="interval"
            hint="Bangumi 未公开限流阈值，默认 1000ms（约 1 次/秒）。网络不稳定时可适当调大。"
          >
            <Input
              id="interval"
              type="number"
              min={0}
              max={10000}
              step={100}
              value={value.requestIntervalMs}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, requestIntervalMs: Number(event.target.value) }))
              }
            />
          </Field>

          <Field
            label="条目详情缓存天数"
            htmlFor="refresh"
            hint="超过该天数的条目会在下次同步时重新抓取详情。"
          >
            <Input
              id="refresh"
              type="number"
              min={1}
              max={3650}
              value={value.detailRefreshDays}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, detailRefreshDays: Number(event.target.value) }))
              }
            />
          </Field>

          <Field
            label="HTTP 代理（可选）"
            htmlFor="proxy"
            hint="例如 http://127.0.0.1:7890。留空则使用系统环境变量。"
          >
            <Input
              id="proxy"
              value={value.httpProxy}
              placeholder="http://127.0.0.1:7890"
              onChange={(event) => setDraft((prev) => ({ ...prev, httpProxy: event.target.value }))}
            />
          </Field>
        </div>

        <Switch
          id="cacheCovers"
          label="同步后自动缓存封面"
          description="把封面下载到本地，断网时依然可以看到封面图（后台进行，不阻塞同步）。"
          checked={value.cacheCovers}
          onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, cacheCovers: checked }))}
        />

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            icon={<Save size={14} />}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const updated = await api.updateConfig({
                  subjectTypes: value.subjectTypes,
                  requestIntervalMs: value.requestIntervalMs,
                  detailRefreshDays: value.detailRefreshDays,
                  httpProxy: value.httpProxy,
                  cacheCovers: value.cacheCovers,
                });
                queryClient.setQueryData(queryKeys.config, updated);
                setDraft({});
                toast.push({ tone: 'success', title: '同步选项已保存' });
              } catch (error) {
                toast.push({
                  tone: 'error',
                  title: '保存失败',
                  description: error instanceof Error ? error.message : String(error),
                });
              } finally {
                setSaving(false);
              }
            }}
          >
            保存同步选项
          </Button>
          {Object.keys(draft).length > 0 ? (
            <Button variant="ghost" onClick={() => setDraft({})}>
              撤销修改
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

function SyncActionsCard() {
  const { status, running, start, cancel, starting, cancelling, isLoading, statusError, refreshStatus } = useSyncController();
  const { data: config } = useConfig();
  const progress = status?.progress;
  const toast = useToast();
  const cannotStart = starting || isLoading || Boolean(statusError);
  async function cancelSync(): Promise<void> {
    try { await cancel(); }
    catch (error) { toast.push({ tone: 'error', title: '无法取消同步', description: error instanceof Error ? error.message : String(error) }); }
  }

  const runSync = useCallback(
    async (options: { mode: 'full' | 'incremental' | 'enrich'; depth?: 1 | 2 }) => {
      try {
        await start(options);
      } catch (error) {
        const hint = error instanceof ApiRequestError ? error.hint : undefined;
        toast.push({
          tone: 'error',
          title: '无法开始同步',
          description: [error instanceof Error ? error.message : String(error), hint]
            .filter(Boolean)
            .join('｜'),
        });
      }
    },
    [start, toast],
  );

  return (
    <Card>
      <CardHeader
        title="手动同步"
        description={
          running
            ? (PHASE_LABEL[progress?.phase ?? 'preparing'] ?? '同步中')
            : isLoading ? '正在读取同步状态…' : statusError ? '同步状态暂不可用' : `上次成功同步：${formatRelative(status?.lastSuccessfulSyncAt)}`
        }
        actions={running ? <Badge tone="accent">同步进行中</Badge> : null}
      />
      <CardBody className="space-y-4 pt-2">
        {statusError ? <InlineNote tone="warning">无法读取同步状态：{statusError.message}{status ? '；当前保留上次读取的状态。' : ''}<Button size="sm" variant="ghost" onClick={refreshStatus}>重试</Button></InlineNote> : null}
        {running && progress ? (
          <div className="space-y-3">
            <ProgressBar value={progress.percent / 100} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-note text-subtle">
              <span>{progress.message}</span>
              <span className="numeric">
                {progress.current}/{progress.total || '—'} · 剩余 {formatEta(progress.etaSeconds)}
              </span>
            </div>
            <div className="grid grid-cols-safe-2 gap-2 sm:grid-cols-safe-4">
              {[
                { label: '新增', value: progress.counters.added },
                { label: '更新', value: progress.counters.updated },
                { label: '详情', value: progress.counters.detailsFetched },
                { label: '失败', value: progress.counters.failures },
              ].map((item) => (
                <div key={item.label} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                  <p className="text-caption text-subtle">{item.label}</p>
                  <p className="mt-0.5 text-card font-semibold numeric">{item.value}</p>
                </div>
              ))}
            </div>
            {progress.issues.length > 0 ? (
              <div className="max-h-[140px] overflow-y-auto rounded-[10px] border border-warning/30 bg-warning-soft/40 p-3">
                <p className="text-caption font-medium text-warning">同步过程中的告警</p>
                <ul className="mt-1 space-y-1">
                  {progress.issues.map((issue) => (
                    <li key={issue} className="text-caption leading-5 text-muted">
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Button variant="danger" icon={<Square size={13} />} loading={cancelling} onClick={() => void cancelSync()}>
              取消同步
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-safe-2 lg:grid-cols-safe-4">
              <Button variant="primary" disabled={cannotStart} icon={<Zap size={14} />} onClick={() => void runSync({ mode: 'incremental' })}>
                增量同步
              </Button>
              <Button disabled={cannotStart} icon={<RefreshCw size={14} />} onClick={() => void runSync({ mode: 'full' })}>
                完整刷新
              </Button>
              <Button disabled={cannotStart} icon={<Gauge size={14} />} onClick={() => void runSync({ mode: 'enrich', depth: 1 })}>
                补全条目详情
              </Button>
              <Button disabled={cannotStart} icon={<Sparkles size={14} />} onClick={() => void runSync({ mode: 'enrich', depth: 2 })}>
                深度同步（人员 + 系列）
              </Button>
            </div>
            <div className="space-y-1 text-caption leading-5 text-subtle">
              <p>
                <strong className="font-medium text-muted">增量同步</strong>
                ：分页拉取全部收藏并对比差异，只写入变化的条目，同时补齐缺失的详情。
              </p>
              <p>
                <strong className="font-medium text-muted">完整刷新</strong>
                ：忽略详情缓存时间，重新抓取所有条目详情（条目较多时耗时较长）。
              </p>
              <p>
                <strong className="font-medium text-muted">深度同步</strong>
                ：额外抓取官方制作人员与系列关系，每个条目需要 2 次额外请求，
                按当前间隔估算约需 {((status?.lastRun?.counters.fetched ?? 0) * 2 * (config?.requestIntervalMs ?? 1000) / 60000).toFixed(1)} 分钟。
              </p>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SyncHistoryCard() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.syncHistory(20),
    queryFn: () => api.syncHistory(20),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader title="同步历史" description="最近 20 次同步的结果与统计" />
      <CardBody className="pt-2">
        {isLoading ? (
          <Skeleton className="h-[160px]" />
        ) : data && data.runs.length > 0 ? (
          <div className="max-h-[320px] overflow-auto">
            <table className="w-full min-w-[620px] border-collapse text-note">
              {/* 粘性表头必须不透明（稳定面板），否则滚动时行内容会透出来 */}
              <thead className="sticky top-0 bg-surface-solid">
                <tr className="border-b border-border text-left text-caption text-subtle">
                  <th className="py-2 pr-3 font-medium">开始时间</th>
                  <th className="py-2 pr-3 font-medium">模式</th>
                  <th className="py-2 pr-3 font-medium">结果</th>
                  <th className="py-2 pr-3 text-right font-medium">新增</th>
                  <th className="py-2 pr-3 text-right font-medium">更新</th>
                  <th className="py-2 pr-3 text-right font-medium">移除</th>
                  <th className="py-2 pr-3 text-right font-medium">详情</th>
                  <th className="py-2 text-right font-medium">耗时</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id} className="border-b border-border/70 last:border-b-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateTime(run.startedAt)}</td>
                    <td className="py-1.5 pr-3">
                      {run.mode === 'full' ? '完整' : run.mode === 'enrich' ? '补全' : '增量'}
                      {run.depth === 2 ? '·深度' : ''}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          run.status === 'success'
                            ? 'text-success'
                            : run.status === 'error'
                              ? 'text-danger'
                              : 'text-warning'
                        }
                      >
                        {run.status === 'success'
                          ? '成功'
                          : run.status === 'error'
                            ? '失败'
                            : run.status === 'cancelled'
                              ? '已取消'
                              : run.status === 'interrupted'
                                ? '已中断'
                                : '进行中'}
                      </span>
                      {run.error ? (
                        <span className="ml-2 text-caption text-subtle" title={run.error}>
                          {run.error.slice(0, 24)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right numeric">{run.counters.added}</td>
                    <td className="py-1.5 pr-3 text-right numeric">{run.counters.updated}</td>
                    <td className="py-1.5 pr-3 text-right numeric">{run.counters.removed}</td>
                    <td className="py-1.5 pr-3 text-right numeric">
                      {run.counters.detailsFetched}
                    </td>
                    <td className="py-1.5 text-right numeric">
                      {run.durationMs === null ? '—' : `${(run.durationMs / 1000).toFixed(1)}s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-note text-subtle">还没有同步记录。</p>
        )}
      </CardBody>
    </Card>
  );
}

/** 外观：主题在这里切换，与顶栏的开关共用同一套本地偏好。 */
function AppearanceCard() {
  return (
    <Card>
      <CardHeader
        title="主题"
        description="深色为默认；跟随系统时会随操作系统的浅色 / 深色设置自动切换。"
      />
      <CardBody className="space-y-3 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-note font-medium">当前主题</p>
            <p className="mt-0.5 text-caption text-subtle">
              选择结果保存在本机浏览器，不随数据库迁移。
            </p>
          </div>
          <ThemeToggle withLabel />
        </div>
        <InlineNote tone="neutral">
          图表、状态色与组件都读取同一套设计令牌，切换主题时会一并更新。
        </InlineNote>
      </CardBody>
    </Card>
  );
}

/**
 * 内容可见性：隐藏 NSFW（v1.5.3）。
 *
 * 只改变展示投影；统计分析与 AI 总结使用完整收藏。
 */
function VisibilityCard() {
  const { data, isLoading } = useConfig();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (isLoading || !data) return <Skeleton className="h-[170px]" />;
  const hidden = data.hideNsfw;

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.updateConfig({ hideNsfw: next });
      await queryClient.cancelQueries({ queryKey: queryKeys.dashboard });
      queryClient.removeQueries({ queryKey: queryKeys.dashboard });
      // Evidence is independently disclosed, but a prior unhidden response must
      // not reappear from cache after the privacy switch is enabled.
      if (next) {
        const predicate = (query: { queryKey: readonly unknown[] }) => ['diagnostics', 'diagnosticsHistory', 'seriesDetail', 'franchiseDetail', 'franchiseGovernance'].includes(String(query.queryKey[0]));
        await queryClient.cancelQueries({ predicate });
        queryClient.removeQueries({ predicate });
      }
      queryClient.setQueryData(queryKeys.config, updated);
      const fullData = new Set(['overview', 'distributions', 'timeline', 'bias', 'studios', 'directors', 'habits', 'profileAi', 'config']);
      await queryClient.invalidateQueries({ predicate: query => !fullData.has(String(query.queryKey[0])) });
      toast.push({
        tone: 'info',
        title: next ? '已隐藏 NSFW 内容' : '已恢复显示 NSFW 内容',
        description: next
          ? '列表、搜索与详情立即生效；数据未被删除，随时可以关闭。'
          : '恢复显示 NSFW 内容；主动隐藏仍然生效。',
      });
    } catch (error) {
      toast.push({
        tone: 'error',
        title: '设置未保存',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="内容可见性"
        description="只控制当前 Analyzer 的显示：不删除数据、不修改收藏，关闭开关即可完整恢复。"
      />
      <CardBody className="space-y-3 pt-2">
        <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
          <Switch
            id="hideNsfw"
            label={
              <span className="flex items-center gap-1.5">
                <EyeOff size={13} className="text-subtle" />
                隐藏 NSFW 内容
              </span>
            }
            description={
              busy
                ? '正在保存…'
                : '判定只依据 Bangumi 的 subject.nsfw；含 NSFW 成员的系列会整体隐藏。家族仅隐藏其中不可见的系列，全部系列隐藏时才整体隐藏；搜索遵循同一策略。'
            }
            checked={hidden}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>
        <InlineNote tone={hidden ? 'warning' : 'neutral'}>
          {hidden
            ? '当前隐藏已开启：NSFW 条目及其所在系列在列表、搜索与详情中不可见；家族仅隐藏其中不可见的系列，全部系列隐藏时才整体隐藏。收藏库会同时标注真实收藏数与当前可见数。'
            : 'NSFW 展示过滤已关闭；主动隐藏仍然生效。可随时重新开启。'}
        </InlineNote>
      </CardBody>
    </Card>
  );
}

/** 关于：应用信息 + 安全说明 + 引导复位（方便重新走一次首次使用流程）。 */
function AboutCard() {
  const { data: config } = useConfig();
  const { data: onboarding } = useLocalProfile();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="关于这个工具"
          description="本地优先的个人动画数据库；除同步外不依赖网络。"
          actions={<Badge tone="neutral">v{config?.version ?? '—'}</Badge>}
        />
        <CardBody className="space-y-2 pt-2 text-note text-muted">
          <p className="flex items-start gap-2">
            <Database size={14} className="mt-1 shrink-0 text-subtle" />
            数据目录：<span className="min-w-0 break-all font-medium text-text">{config?.dataDir ?? '—'}</span>
          </p>
          <p className="flex items-start gap-2">
            <Clock size={14} className="mt-1 shrink-0 text-subtle" />
            Token 仅保存在本机 data/config.json（权限 600），前端接口只返回「已配置 / 未配置」与掩码提示。
          </p>
          <p className="flex items-start gap-2">
            <Play size={14} className="mt-1 shrink-0 text-subtle" />
            服务默认只监听 127.0.0.1，不接受外部设备连接；如需局域网访问请自行修改 HOST 并注意风险。
          </p>
          <p className="flex items-start gap-2">
            <BadgeCheck size={14} className="mt-1 shrink-0 text-subtle" />
            日志会过滤 Token / Authorization 等敏感字段；导出文件不包含任何凭据。
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="首次使用引导"
          description={
            onboarding?.steps?.every(step => step.done)
              ? '初始化步骤已完成，引导默认收起；仍可重新查看。'
              : onboarding?.seen
                ? '已跳过引导，未完成的步骤仍保留；已有本地数据可继续离线使用。'
              : '引导会在资料 / Bangumi 配置 / 同步都完成前显示在「个人资料」页。'
          }
        />
        <CardBody className="pt-2">
          <Link to="/me?onboarding=show"><Button
            size="sm"
            icon={<RefreshCw size={13} />}
          >
            重新显示引导
          </Button></Link>
        </CardBody>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { data: config, error, refetch } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: SettingsTab = (TABS.find((item) => item.value === requested)?.value ?? 'bangumi');

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="设置"
        description={config ? `本地优先：所有数据保存在 ${config.dataDir}` : '账号与同步、AI、外观、数据管理'}
        actions={
          <Badge tone="neutral">
            <Database size={10} /> 数据库 {(config?.dbSizeBytes ?? 0) / 1024 / 1024 < 0.1
              ? `${Math.max(1, Math.round((config?.dbSizeBytes ?? 0) / 1024))} KB`
              : `${((config?.dbSizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`}
          </Badge>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(next) => {
          const params = new URLSearchParams(searchParams);
          params.set('tab', next);
          setSearchParams(params, { replace: true });
        }}
      >
        <TabList>
          {TABS.map((item) => (
            <TabTrigger key={item.value} value={item.value}>
              {item.label}
            </TabTrigger>
          ))}
        </TabList>

        <TabContent value="bangumi">
          <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-safe-2">
              <CredentialsCard />
              <SyncPreferencesCard />
            </div>
            <SyncActionsCard />
            <SyncHistoryCard />
            <p className="text-caption text-subtle">
              同步范围：{config?.subjectTypes.length === 1 ? '仅动画条目' : `全部 ${config?.subjectTypes.length ?? 0} 种条目类型`}{' '}
              · 请求间隔 {config?.requestIntervalMs ?? 0} ms · 详情缓存 {config?.detailRefreshDays ?? 0} 天
            </p>
          </div>
        </TabContent>

        <TabContent value="ai">
          <div className="space-y-4">
            <AiSettingsCard />
            <TranslationSettingsCard />
          </div>
        </TabContent>

        <TabContent value="appearance">
          <div className="space-y-4">
            <AppearanceCard />
            <WallpaperSettingsCard />
            <MaterialSettingsCard />
            <VisibilityCard />
            <HiddenWorksCard />
          </div>
        </TabContent>

        <TabContent value="data">
          <DataManagementCard />
        </TabContent>

        <TabContent value="about">
          <AboutCard />
        </TabContent>
      </Tabs>
    </div>
  );
}
