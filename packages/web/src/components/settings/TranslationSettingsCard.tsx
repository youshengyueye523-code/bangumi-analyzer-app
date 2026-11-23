import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Download, Languages, PauseCircle, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";
import type { AppConfigPublic } from "@bangumi-analyzer/shared";
import { api } from "../../lib/api.js";
import { formatNumber } from "../../lib/format.js";
import { queryKeys, useConfig, useTranslationStatus } from "../../lib/queries.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardBody, CardHeader } from "../ui/card.js";
import { InlineNote, Skeleton } from "../ui/feedback.js";
import { Field, SelectMenu, Switch } from "../ui/form.js";
import { useToast } from "../ui/toast.js";

/**
 * 「简介翻译」设置：开关 + 并发 + 队列总览 + 手动批量操作。
 *
 * 统计口径（与后端 `counts` / `totals` 一一对应）：
 *   - 队列计数只统计「与作品当前原文 hash 一致」的任务；
 *   - 「历史失效」是原文已更新、仅作历史记录保留的旧任务，不计入失败；
 *   - 「按中文来源」与「按原文语言」是两个互不重叠的口径，不能相加。
 */
export function TranslationSettingsCard() {
  const configQuery = useConfig();
  const statusQuery = useTranslationStatus();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const config = configQuery.data;
  const status = statusQuery.data;

  async function saveConfig(patch: Partial<AppConfigPublic>): Promise<void> {
    setBusy("config");
    try {
      const updated = await api.updateConfig(patch);
      queryClient.setQueryData(queryKeys.config, updated);
      // 配置变化后立刻唤醒 worker（例如刚补上 API Key）
      await api.translationQueueAction("wake");
      await queryClient.invalidateQueries({ queryKey: queryKeys.translationStatus });
    } catch (error) {
      toast.push({
        tone: "error",
        title: "保存失败",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  async function runAction(action: "backfill" | "retry-all" | "cancel-all"): Promise<void> {
    setBusy(action);
    try {
      await api.translationQueueAction(action);
      await queryClient.invalidateQueries({ queryKey: queryKeys.translationStatus });
      toast.push({
        tone: action === "cancel-all" ? "warning" : "success",
        title:
          action === "backfill"
            ? "已重新扫描收藏库并补齐翻译队列"
            : action === "retry-all"
              ? "失败任务已重新排队"
              : "已取消未完成的翻译任务",
        description:
          action === "cancel-all"
            ? "已完成的翻译与 Bangumi 原文都没有被修改。"
            : "后台会按并发上限逐步处理，不影响其他功能。",
      });
    } catch (error) {
      toast.push({
        tone: "error",
        title: "操作失败",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  if (configQuery.isLoading || !config) return <Skeleton className="h-[220px]" />;

  const counts = status?.counts;
  const totals = status?.totals;
  const queueBusy = (counts?.pending ?? 0) + (counts?.processing ?? 0);
  const needsAttention = (counts?.failed ?? 0) + (counts?.waiting_ai ?? 0);

  return (
    <Card>
      <CardHeader
        title="简介翻译（非中文简介 → 中文）"
        description="Bangumi 官方中文直接使用；日文 / 英文 / 韩文等可识别语言进入统一翻译队列；语言无法识别时保留原文，不调用 AI。"
        actions={
          status ? (
            status.aiConfigured ? (
              <Badge tone="success">AI 已配置</Badge>
            ) : (
              <Badge tone="warning">待配置 AI</Badge>
            )
          ) : null
        }
      />
      <CardBody className="space-y-4 pt-2">
        <div className="grid gap-4 md:grid-cols-safe-2">
          <Switch
            id="summaryAutoTranslate"
            label="同步后自动翻译非中文简介"
            description="只影响「进入翻译队列」这一步；AI 未配置时任务会暂停，配置后自动继续。"
            checked={config.summaryAutoTranslate}
            onCheckedChange={(checked) => void saveConfig({ summaryAutoTranslate: checked })}
          />
          <Field
            label="翻译并发数"
            htmlFor="summaryConcurrency"
            hint="同时向 AI 发起的请求数（1–8）。默认 2，网络不稳定时建议保持较小值。"
          >
            {/* 统一使用 SelectMenu：展开层走设计 token，不再由系统绘制 */}
            <SelectMenu
              id="summaryConcurrency"
              ariaLabel="翻译并发数"
              value={config.summaryConcurrency}
              disabled={busy === "config"}
              options={[1, 2, 3, 4, 6, 8].map((value) => ({
                value,
                label: `${value} 个并发`,
              }))}
              onChange={(next) => void saveConfig({ summaryConcurrency: next })}
            />
          </Field>
        </div>

        {status ? (
          <>
            <div className="grid grid-cols-safe-2 gap-2 sm:grid-cols-safe-3 lg:grid-cols-safe-5">
              {[
                { label: "待翻译", value: counts?.pending ?? 0, hint: "当前有效任务" },
                { label: "翻译中", value: counts?.processing ?? 0, hint: "当前有效任务" },
                { label: "已翻译", value: counts?.completed ?? 0, hint: "对应当前原文" },
                { label: "翻译失败", value: counts?.failed ?? 0, hint: "需要人工重试" },
                {
                  label: "历史失效",
                  value: counts?.obsolete ?? 0,
                  hint: "原文已更新，仅作历史",
                },
              ].map((item) => (
                <div key={item.label} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                  <p className="text-caption text-subtle">{item.label}</p>
                  <p className="numeric mt-0.5 text-section">{formatNumber(item.value)}</p>
                  <p className="mt-0.5 text-caption text-subtle">{item.hint}</p>
                </div>
              ))}
            </div>

            {/* 两个互不重叠的统计口径，分开显示，避免相加造成误读 */}
            {totals ? (
              <div className="space-y-1 text-caption text-subtle">
                <p>
                  <strong className="font-medium text-muted">按中文来源</strong>（互斥，共{" "}
                  {formatNumber(totals.collected)} 条）：官方中文 {formatNumber(totals.officialChinese)} · AI 翻译{" "}
                  {formatNumber(totals.translated)} · 待翻译 {formatNumber(totals.untranslated)} · 无简介{" "}
                  {formatNumber(totals.noSummary)}
                </p>
                <p>
                  <strong className="font-medium text-muted">按原文语言</strong>（互斥）：中文{" "}
                  {formatNumber(totals.bySourceLanguage.zh ?? 0)} · 日文{" "}
                  {formatNumber(totals.bySourceLanguage.ja ?? 0)} · 英文{" "}
                  {formatNumber(totals.bySourceLanguage.en ?? 0)} · 韩文{" "}
                  {formatNumber(totals.bySourceLanguage.ko ?? 0)} · 其他语言{" "}
                  {formatNumber(totals.bySourceLanguage.other ?? 0)} · 无法识别{" "}
                  {formatNumber(totals.bySourceLanguage.unknown ?? 0)} · 无简介{" "}
                  {formatNumber(totals.bySourceLanguage.empty ?? 0)}
                </p>
                <p>
                  其中双语结构（官方中文 + 原文，含分隔标记）{formatNumber(totals.bilingual)} 条；
                  基于旧版原文、等待重新翻译的历史翻译 {formatNumber(totals.stale)} 条；
                  已被官方中文取代的历史 AI 翻译 {formatNumber(totals.supersededAi)} 条
                  （两者都不计入「已翻译」）。
                </p>
              </div>
            ) : null}

            {counts && counts.waiting_ai > 0 ? (
              <InlineNote tone="warning">
                有 {formatNumber(counts.waiting_ai)} 条任务在等待 AI 配置
                {status.aiConfigured ? "（已配置，将在下次唤醒时自动继续）" : `（${status.aiReason}）`}。
                其余功能不受影响。
              </InlineNote>
            ) : null}

            {status.lastError ? (
              <InlineNote tone="neutral">
                <span className="flex items-start gap-1.5">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  最近一次翻译错误：{status.lastError}
                </span>
              </InlineNote>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={<Download size={13} />}
                loading={busy === "backfill"}
                onClick={() => void runAction("backfill")}
              >
                重新扫描并补齐队列
              </Button>
              <Button
                size="sm"
                icon={<RefreshCw size={13} />}
                loading={busy === "retry-all"}
                disabled={needsAttention === 0}
                onClick={() => void runAction("retry-all")}
              >
                重试失败任务
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<PauseCircle size={13} />}
                loading={busy === "cancel-all"}
                disabled={queueBusy === 0}
                onClick={() => void runAction("cancel-all")}
              >
                取消未完成任务
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Zap size={13} />}
                onClick={() => void api.translationQueueAction("wake")}
              >
                立即唤醒队列
              </Button>
            </div>

            <p className="flex items-center gap-1.5 text-caption text-subtle">
              <Languages size={12} className="shrink-0" />
              {queueBusy > 0
                ? `队列正在处理（剩余 ${queueBusy} 条），完成一条立即写入本地数据库，断网也能查看。`
                : needsAttention > 0 && counts && counts.waiting_ai > 0
                  ? "队列暂停在「待配置 AI」，配置完成后自动继续。"
                  : "队列已空闲。已完成的翻译保存在本机数据库，不会再次调用 AI。"}
            </p>
          </>
        ) : (
          <Skeleton className="h-[120px]" />
        )}
      </CardBody>
    </Card>
  );
}
