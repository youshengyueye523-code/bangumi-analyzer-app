import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Languages,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  LANGUAGE_LABEL,
  SUMMARY_CHINESE_SOURCE_LABEL,
  TRANSLATION_STATUS_LABEL,
  type SubjectSummaryState,
  type SummaryLanguage,
} from '@bangumi-analyzer/shared';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { useToast } from '../ui/toast.js';
import { queryKeys } from '../../lib/queries.js';

/** 原始简介的标签：Bangumi 原文（按真实源语言标注，例如「英文」「韩文」） */
function originalLabel(language: SummaryLanguage): string {
  const label = LANGUAGE_LABEL[language];
  if (language === 'empty' || language === 'zh') return 'Bangumi 原文';
  return `Bangumi 原文（${label}）`;
}

function StatusBadge({ state }: { state: SubjectSummaryState }) {
  if (state.chineseSource === 'bangumi') return <Badge tone="info">官方中文</Badge>;
  if (state.chineseSource === 'ai') {
    return (
      <>
        <Badge tone="accent">AI 翻译</Badge>
        {state.stale ? <Badge tone="warning">基于旧版原文</Badge> : null}
      </>
    );
  }
  switch (state.status) {
    case 'pending':
      return <Badge tone="neutral">{TRANSLATION_STATUS_LABEL.pending}</Badge>;
    case 'processing':
      return (
        <Badge tone="accent">
          <Loader2 size={10} className="animate-spin" />
          {TRANSLATION_STATUS_LABEL.processing}
        </Badge>
      );
    case 'failed':
      return <Badge tone="danger">{TRANSLATION_STATUS_LABEL.failed}</Badge>;
    case 'waiting_ai':
      return <Badge tone="warning">{TRANSLATION_STATUS_LABEL.waiting_ai}</Badge>;
    default:
      return null;
  }
}

function Block({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[10px] border border-border bg-surface-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-note font-medium text-muted">{title}</p>
        {badge}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * 作品简介：中文优先，原文默认折叠。
 *
 * 展示规则与数据层保持一致：
 *   - 官方中文简介 → 直接显示，标注来源，不调用 AI；
 *   - 可翻译外文   → 入队翻译（日文 / 英文 / 韩文等可识别语言），中文结果标注「AI 翻译」；
 *   - 语言无法识别 → 保留原文并说明原因，不调用 AI；
 *   - 没有简介     → 显示「暂无简介」，不产生任何任务。
 */
export function SummarySection({ state }: { state: SubjectSummaryState }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 用户手动展开过原文后，不再被自动折叠覆盖 */
  const [touched, setTouched] = useState(false);

  // 「原文与中文都可用」时默认折叠原文；只有原文可看时自动展开，避免空白
  useEffect(() => {
    if (touched) return;
    setShowOriginal(!state.chinese && Boolean(state.original));
  }, [state.chinese, state.original, touched]);

  // 翻译任务进行中时轮询，完成后自动展示中文（不需要刷新页面）
  useEffect(() => {
    if (state.status !== 'pending' && state.status !== 'processing') return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subject(state.subjectId) });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [state.status, state.subjectId, queryClient]);

  const hasOriginal = Boolean(state.original.trim());
  const hasChinese = Boolean(state.chinese.trim());
  // 已经有官方中文（纯中文简介或混合双语）时不需要 AI 翻译，也不提供入口
  const showTranslateAction = state.translatable && hasOriginal && !hasChinese;

  async function runAction(action: 'translate' | 'cancel'): Promise<void> {
    setBusy(true);
    try {
      if (action === 'translate') {
        await api.translateSubject(state.subjectId);
        toast.push({
          tone: 'info',
          title: state.chinese ? '已排入重新翻译' : '已加入翻译队列',
          description: '翻译在后台进行，完成后这里会自动更新；原文不会被修改。',
        });
      } else {
        await api.cancelSubjectTranslation(state.subjectId);
        toast.push({ tone: 'warning', title: '已取消翻译任务', description: '原文与已有翻译都保持不变。' });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.subject(state.subjectId) });
    } catch (error) {
      toast.push({
        tone: 'error',
        title: action === 'translate' ? '无法开始翻译' : '无法取消任务',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  /*
   * 只有「中文和原文都没有」才是真正的没有简介。
   * 纯官方中文简介没有原文段（中文本身就是原文），必须走正常展示分支，
   * 否则会被误判成「暂无简介」。
   */
  if (!hasOriginal && !hasChinese) {
    return (
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-caption text-subtle">简介</p>
        <p className="mt-1 text-note text-subtle">暂无简介（Bangumi 未提供简介，不会调用 AI 生成内容）</p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2.5 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-caption text-subtle">简介</p>
          <StatusBadge state={state} />
          {state.chineseSource === 'ai' && state.translationModel ? (
            <span className="text-caption text-subtle" title={state.translationProvider}>
              {state.translationModel}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {state.status === 'pending' || state.status === 'processing' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={13} />}
              loading={busy}
              onClick={() => void runAction('cancel')}
            >
              取消任务
            </Button>
          ) : null}
          {showTranslateAction && state.status !== 'processing' ? (
            <Button
              size="sm"
              icon={
                state.chinese ? <RotateCcw size={13} /> : state.status === 'failed' ? (
                  <RotateCcw size={13} />
                ) : (
                  <Sparkles size={13} />
                )
              }
              loading={busy}
              onClick={() => void runAction('translate')}
            >
              {state.chinese ? '重新翻译' : state.status === 'failed' ? '重试失败' : '立即翻译'}
            </Button>
          ) : null}
        </div>
      </div>

      {/* 第一层：中文（优先阅读） */}
      {state.chinese ? (
        <Block
          title="中文简介"
          badge={
            <span className="text-caption text-subtle">
              {SUMMARY_CHINESE_SOURCE_LABEL[state.chineseSource]}
              {state.bilingual ? '（Bangumi 双语简介）' : ''}
              {state.chineseSource === 'ai' && state.translationUpdatedAt
                ? ` · ${formatDateTime(state.translationUpdatedAt)}`
                : ''}
            </span>
          }
        >
          {/* 中文与原文使用同一级正文字号与行高：中文是主要阅读内容，不做成小字备注 */}
          <p className="max-w-[760px] whitespace-pre-line text-body leading-7 text-text">
            {state.chinese}
          </p>
          {state.stale ? (
            <p className="mt-2 flex items-start gap-1.5 text-caption text-warning">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              Bangumi 原文已更新，这段中文翻译基于旧版原文；重新翻译完成后会自动替换。
            </p>
          ) : null}
          {state.bilingual ? (
            <p className="mt-2 text-caption text-subtle">
              这条简介在 Bangumi 上就是「日文原文 + 官方中文」结构，下方原文区域可以直接对照。
            </p>
          ) : null}
        </Block>
      ) : (
        <Block title="中文简介">
          <p className="text-note text-subtle">
            {state.status === 'waiting_ai'
              ? `待配置 AI：${state.translationError ?? '请在「设置 → AI」中填写 API Key，之后队列会自动继续。'}`
              : state.status === 'failed'
                ? `翻译失败${state.translationError ? `：${state.translationError}` : ''}（原文与收藏数据不受影响）`
                : state.status === 'processing'
                  ? 'AI 正在翻译这条简介…'
                  : state.status === 'pending'
                    ? '已进入翻译队列，等待后台处理…'
                    : state.translatable
                      ? '尚未翻译，可点击「立即翻译」'
                      : state.unsupportedReason || '暂无法识别原文语言，已保留原文（未调用 AI）'}
          </p>
        </Block>
      )}

      {/* 第二层：原文（默认折叠）；纯官方中文简介没有原文段时不渲染这一块 */}
      {hasOriginal ? (
      <div className="rounded-[10px] border border-border bg-surface-2 px-3.5 py-3">
        <button
          type="button"
          aria-expanded={showOriginal}
          onClick={() => {
            setTouched(true);
            setShowOriginal((value) => !value);
          }}
          className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showOriginal ? <ChevronDown size={14} className="shrink-0 text-subtle" /> : <ChevronRight size={14} className="shrink-0 text-subtle" />}
          <span className="text-note font-medium text-muted">{originalLabel(state.originalLanguage)}</span>
          <Badge tone="neutral">
            <Languages size={10} /> {LANGUAGE_LABEL[state.originalLanguage]}
          </Badge>
          <span className="text-caption text-subtle">
            {showOriginal ? '点击折叠' : '点击展开（一手资料，可对照核对）'}
          </span>
        </button>
        {showOriginal ? (
          <p
            className={cn(
              'mt-2 max-w-[760px] whitespace-pre-line text-muted',
              // 与中文简介同一级正文字号与行高
              'text-body leading-7',
            )}
          >
            {state.original}
          </p>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}
