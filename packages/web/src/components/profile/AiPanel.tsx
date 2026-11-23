import { Bot, ChevronDown, Sparkles, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ProfileAiStatus } from '@bangumi-analyzer/shared';
import { formatDateTime } from '../../lib/format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { ErrorState, InlineNote } from '../ui/feedback.js';
import { Dropdown, DropdownItem } from '../ui/overlay.js';

function reportLabel(report: ProfileAiStatus['reports'][number]): string {
  return `${formatDateTime(report.createdAt)} · ${report.model} · ${report.upToDate ? '当前口径' : '历史'}`;
}

/**
 * AI 总结区：未配置时只做说明（统计画像不受影响）；
 * 配置后由用户显式点击生成，报告会连带「使用的数据版本」一起展示。
 */
export function AiPanel({
  status,
  statusLoading = false,
  statusError,
  onStatusRetry,
  onSelectReport,
  error,
  generating,
  onCancel,
  onGenerate,
}: {
  status: ProfileAiStatus | undefined;
  statusLoading?: boolean;
  statusError?: unknown;
  onStatusRetry?: () => void;
  onSelectReport?: (id: number) => void;
  error: unknown;
  generating: boolean;
  onCancel?: () => void;
  onGenerate: (force?: boolean) => Promise<void>;
}) {
  const statusReady = Boolean(status) && !statusLoading && !statusError;
  const report = statusReady ? status?.report ?? null : null;

  return (
    <Card>
      <CardHeader
        title="AI 总结"
        description="AI 基于完整收藏（包括主动隐藏作品）生成复盘，结果可能引用这些作品。仅主动生成时请求已配置的服务，可能产生费用。"
        actions={
          !statusReady ? null : status?.configured ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Sparkles size={13} />}
              loading={generating}
              disabled={generating || status.generating}
              onClick={() => void onGenerate(report?.upToDate === true)}
            >
              {report?.upToDate ? '重新生成' : '生成总结'}
            </Button>
          ) : (
            <Link to="/settings?tab=ai">
              <Button size="sm">去配置 AI</Button>
            </Link>
          )
        }
      />
      <CardBody className="space-y-4 pt-2">
        {statusLoading || (!status && !statusError) ? (
          <InlineNote tone="neutral">正在读取 AI 状态；本地统计画像仍可使用。</InlineNote>
        ) : null}
        {statusError ? (
          <InlineNote tone="warning">
            <div role="alert" className="space-y-2">
              <p>无法读取 AI 状态：{statusError instanceof Error ? statusError.message : '读取失败'}。不能据此判断配置或报告是否存在。</p>
              <Button size="sm" loading={statusLoading} onClick={onStatusRetry}>重试读取 AI 状态</Button>
            </div>
          </InlineNote>
        ) : null}
        {statusReady && status?.configured && !report ? (
          <InlineNote tone="neutral">尚未生成 AI 总结。只有主动点击生成才会请求 AI 服务。</InlineNote>
        ) : null}
        {statusReady && !status?.configured ? (
          <InlineNote tone="neutral">
            <span className="flex items-start gap-2">
              <Bot size={14} className="mt-0.5 shrink-0" />
              <span>
                当前未启用 AI 总结：<strong className="font-medium">{status?.reason ?? '未配置'}</strong>。
                上面的统计画像不依赖 AI，可以照常使用；
                需要自然语言复盘时再到「设置 → AI」填写接口地址与 API Key（Key 只保存在本机）。
              </span>
            </span>
          </InlineNote>
        ) : null}

        {generating ? (
          <Button size="sm" onClick={onCancel}>停止等待</Button>
        ) : statusReady && status?.generating ? (
          <InlineNote tone="neutral">已有生成请求正在处理。 <Button size="sm" onClick={onStatusRetry}>读取 AI 状态</Button></InlineNote>
        ) : null}
        {error ? (
          <div className="space-y-2">
            <ErrorState error={error} />
            <Button size="sm" onClick={onStatusRetry}>读取报告状态（不重新生成）</Button>
          </div>
        ) : null}

        {report ? (
          <div className="space-y-4">
            {(status?.reports?.length ?? 0) > 1 ? (
              <div className="w-full min-w-0 max-w-[480px] space-y-1 text-note">
                <div>选择 AI 总结</div>
                <Dropdown
                  align="start"
                  contentClassName="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 max-w-[calc(100vw-24px)] max-h-[min(45vh,240px,var(--radix-dropdown-menu-content-available-height))] overflow-x-hidden border-[#64748b] bg-[#111827] text-[#f8fafc] shadow-[var(--shadow-pop)] [color-scheme:dark]"
                  trigger={
                    <button
                      type="button"
                      aria-label={`选择 AI 总结：${reportLabel(report)}`}
                      className="flex w-full min-w-0 items-center justify-between gap-2 rounded-control border border-[#64748b] bg-[#111827] px-3 py-2 text-left text-[#f8fafc] hover:bg-[#243047] focus-visible:outline-2 focus-visible:outline-[#93c5fd]"
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">{reportLabel(report)}</span>
                      <ChevronDown size={14} className="shrink-0" />
                    </button>
                  }
                >
                  {status?.reports.map(item => (
                    <DropdownItem
                      key={item.id}
                      selected={item.id === report.id}
                      className={item.id === report.id
                        ? 'bg-[#1e3a5f] text-white data-[highlighted]:bg-[#275074] active:bg-[#275074]'
                        : 'text-[#f8fafc] data-[highlighted]:bg-[#243047] active:bg-[#243047]'}
                      onSelect={() => onSelectReport?.(item.id)}
                    >
                      <span className="block whitespace-normal [overflow-wrap:anywhere]">{reportLabel(item)}</span>
                    </DropdownItem>
                  ))}
                </Dropdown>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-caption text-subtle">
              <Badge tone={report.upToDate ? 'success' : 'neutral'}>
                {report.upToDate ? '基于当前分析输入' : '历史总结 · 原样保留'}
              </Badge>
              <span>
                {report.model} · {formatDateTime(report.createdAt)}
                {report.usage.promptTokens ? ` · 输入 ${report.usage.promptTokens} tokens` : ''}
                {report.usage.completionTokens ? ` · 输出 ${report.usage.completionTokens} tokens` : ''}
              </span>
            </div>

            <div className="rounded-[14px] border border-accent/30 bg-accent-soft/25 px-4 py-3">
              <p className="text-note font-semibold text-accent">AI 总结</p>
              <p className="mt-1.5 whitespace-pre-line text-body leading-7">{report.output.verdict}</p>
            </div>

            <div className="grid gap-3 lg:grid-cols-safe-2">
              {report.output.sections.map((section) => (
                <article
                  key={section.id}
                  className={
                    section.kind === 'data'
                      ? 'card-surface flex flex-col gap-2 p-4'
                      : 'flex flex-col gap-2 rounded-[14px] border border-dashed border-warning/40 bg-warning-soft/20 p-4'
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-body font-semibold">{section.title}</h4>
                    <Badge tone={section.kind === 'data' ? 'accent' : 'warning'} className="shrink-0">
                      {section.kind === 'data' ? '数据结论' : 'AI 推测'}
                    </Badge>
                  </div>
                  <p className="text-note leading-6 text-muted">{section.statement}</p>
                  {section.evidence.length > 0 ? (
                    <ul className="space-y-1 border-t border-border/70 pt-2">
                      {section.evidence.map((line) => (
                        <li key={line} className="flex gap-2 text-caption leading-5 text-subtle">
                          <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-subtle" />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))}
            </div>

            {report.output.uncertainties.length > 0 || report.output.surprises.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-safe-2">
                {report.output.uncertainties.length > 0 ? (
                  <div className="rounded-[14px] border border-border bg-surface-2 p-4">
                    <p className="text-note font-semibold">当前数据无法判断的部分</p>
                    <ul className="mt-2 space-y-1">
                      {report.output.uncertainties.map((line) => (
                        <li key={line} className="text-caption leading-5 text-subtle">
                          · {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {report.output.surprises.length > 0 ? (
                  <div className="rounded-[14px] border border-border bg-surface-2 p-4">
                    <p className="flex items-center gap-1.5 text-note font-semibold">
                      <TriangleAlert size={12} className="text-warning" />
                      与你自己认知可能不同的地方
                    </p>
                    <ul className="mt-2 space-y-1">
                      {report.output.surprises.map((line) => (
                        <li key={line} className="text-caption leading-5 text-subtle">
                          · {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
