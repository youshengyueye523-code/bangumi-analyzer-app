import { AlertTriangle, CheckCircle2, Database, RefreshCw, Square, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatEta, formatRelative } from '../../lib/format.js';
import { useSyncController } from '../../lib/queries.js';
import { Button, IconButton } from '../ui/button.js';
import { InlineNote, ProgressBar } from '../ui/feedback.js';
import { Popover } from '../ui/overlay.js';
import { useToast } from '../ui/toast.js';

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

export function SyncButton({ compact = false }: { compact?: boolean }) {
  const { status, running, start, cancel, starting, cancelling, isLoading, statusError, refreshStatus } = useSyncController();
  const progress = status?.progress;
  const toast = useToast();
  const navigate = useNavigate();
  const wasRunning = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (wasRunning.current && !running) {
      const run = status?.lastRun;
      if (run?.status === 'success') {
        toast.push({
          tone: 'success',
          title: '同步完成',
          description: `新增 ${run.counters.added} · 更新 ${run.counters.updated} · 移除 ${run.counters.removed}`,
        });
      } else if (run?.status === 'error') {
        toast.push({
          tone: 'error',
          title: '同步失败',
          description: run.error ?? '请查看同步详情',
        });
      } else if (run?.status === 'cancelled') {
        toast.push({ tone: 'warning', title: '同步已取消', description: '已同步的数据保持可用。' });
      }
    }
    wasRunning.current = running;
  }, [running, status?.lastRun, toast]);

  const lastRun = status?.lastRun;
  const percent = progress?.percent ?? 0;

  /** 统一的同步启动入口：失败时给出可读提示，而不是静默失败。 */
  const runSync = useCallback(
    async (options: {
      mode: 'full' | 'incremental' | 'enrich';
      depth?: 1 | 2;
      forceDetail?: boolean;
    }) => {
      try {
        await start(options);
        setOpen(false);
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

  const label = running
    ? (PHASE_LABEL[progress?.phase ?? 'preparing'] ?? '同步中')
    : statusError ? '状态未知' : starting ? '启动中' : isLoading ? '读取中' : lastRun?.status === 'error'
      ? '同步失败'
      : '同步';
  const cannotStart = starting || isLoading || Boolean(statusError);
  async function cancelSync(): Promise<void> {
    try { await cancel(); }
    catch (error) { toast.push({ tone: 'error', title: '无法取消同步', description: error instanceof Error ? error.message : String(error) }); }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width={380}
      align="end"
      trigger={
        <button
          type="button"
          className={cn(
            'inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-note font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            running
              ? 'border-accent/40 bg-accent-soft text-accent'
              : lastRun?.status === 'error'
                ? 'border-danger/40 bg-danger-soft text-danger'
                : 'border-border bg-surface-2 text-muted hover:text-text',
          )}
          title="Bangumi 同步"
        >
          {running ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : lastRun?.status === 'error' ? (
            <AlertTriangle size={14} />
          ) : (
            <Database size={14} />
          )}
          {compact ? null : (
            <span className="numeric hidden sm:inline">
              {running ? `${Math.round(percent)}%` : label}
            </span>
          )}
        </button>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-body font-semibold">Bangumi 数据同步</p>
            <p className="mt-0.5 text-caption text-subtle">
              {running
                ? (PHASE_LABEL[progress?.phase ?? 'preparing'] ?? '同步中')
                : isLoading ? '正在读取同步状态…' : statusError ? '同步状态暂不可用' : `上次同步：${formatRelative(status?.lastSuccessfulSyncAt)}`}
            </p>
          </div>
          {running ? null : (
            <IconButton label="立即同步" disabled={cannotStart} onClick={() => void runSync({ mode: 'incremental' })}>
              <Zap size={15} />
            </IconButton>
          )}
        </div>

        {statusError ? <InlineNote tone="warning">无法读取同步状态：{statusError.message}{status ? '；当前保留上次读取的状态。' : ''}<Button size="sm" variant="ghost" onClick={refreshStatus}>重试</Button></InlineNote> : null}
        {running && progress ? (
          <div className="space-y-2">
            <ProgressBar value={percent / 100} />
            <div className="flex items-center justify-between text-caption text-subtle">
              <span className="truncate">{progress.message}</span>
              <span className="shrink-0 numeric">{formatEta(progress.etaSeconds)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-caption">
              <Stat label="请求" value={progress.counters.requests} />
              <Stat label="详情" value={progress.counters.detailsFetched} />
              <Stat label="失败" value={progress.counters.failures} />
            </div>
            <Button
              size="sm"
              variant="danger"
              className="w-full justify-center"
              icon={<Square size={12} />}
              loading={cancelling}
              onClick={() => void cancelSync()}
            >
              取消同步
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {statusError || isLoading ? (
              <p className="text-caption text-subtle">尚未确认同步记录，请等待状态读取或重试。</p>
            ) : lastRun ? (
              <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-caption leading-5">
                <div className="flex items-center gap-1.5">
                  {lastRun.status === 'success' ? (
                    <CheckCircle2 size={13} className="text-success" />
                  ) : (
                    <AlertTriangle size={13} className="text-warning" />
                  )}
                  <span className="font-medium">
                    上次同步{lastRun.status === 'success' ? '成功' : '未完成'}
                  </span>
                  <span className="text-subtle">{formatRelative(lastRun.finishedAt)}</span>
                </div>
                <p className="mt-1 text-subtle">
                  新增 {lastRun.counters.added} · 更新 {lastRun.counters.updated} · 未变化{' '}
                  {lastRun.counters.unchanged} · 移除 {lastRun.counters.removed}
                </p>
                {lastRun.error ? <p className="mt-1 text-danger">{lastRun.error}</p> : null}
              </div>
            ) : (
              <p className="rounded-[10px] border border-dashed border-border px-3 py-3 text-caption text-subtle">
                还没有同步记录。先在「设置」里填写 Bangumi 用户名（建议同时配置 Access Token），
                然后执行第一次完整同步。
              </p>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="primary" disabled={cannotStart} onClick={() => void runSync({ mode: 'incremental' })}>
                增量同步
              </Button>
              <Button size="sm" disabled={cannotStart} onClick={() => void runSync({ mode: 'full' })}>
                完整刷新
              </Button>
              <Button size="sm" disabled={cannotStart} onClick={() => void runSync({ mode: 'enrich', depth: 1 })}>
                补全详情
              </Button>
              <Button size="sm" disabled={cannotStart} onClick={() => void runSync({ mode: 'enrich', depth: 2 })}>
                深度同步
              </Button>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/settings?tab=bangumi');
              }}
              className="w-full rounded-[10px] border border-border px-3 py-1.5 text-caption text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              前往设置查看同步选项与历史
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-subtle">{label}</p>
      <p className="mt-0.5 text-body font-semibold numeric text-text">{value}</p>
    </div>
  );
}
