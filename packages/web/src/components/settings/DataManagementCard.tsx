import {
  DatabaseBackup,
  Download,
  FileJson,
  FileSpreadsheet,
  HardDriveDownload,
  Image,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState, type MouseEvent } from 'react';
import { downloadFullData } from '../../lib/userGovernance.js';
import { useQueryClient } from '@tanstack/react-query';
import type { ImportPreview } from '@bangumi-analyzer/shared';
import { ApiRequestError, api } from '../../lib/api.js';
import { formatDateTime, formatNumber, formatPercent } from '../../lib/format.js';
import { useBackups, useConfig, useCoverStatus } from '../../lib/queries.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { InlineNote } from '../ui/feedback.js';
import { Dialog } from '../ui/overlay.js';
import { useToast } from '../ui/toast.js';

export function DataManagementCard() {
  const { data: config } = useConfig();
  const { data: backups, refetch: refetchBackups } = useBackups();
  const { data: coverStatus, refetch: refetchCover } = useCoverStatus(true);
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingPayload, setPendingPayload] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<string | null>(null);

  function download(event:MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    void downloadFullData(event.currentTarget.href).catch(()=>toast.push({title:'下载未完成',tone:'error'}));
  }

  async function handleFile(file: File): Promise<void> {
    if (previewLoading || busy !== null) return;
    setPreviewLoading(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await api.importPreview(payload);
      setPendingPayload(payload);
      setPreview(result);
    } catch (error) {
      toast.push({
        tone: 'error',
        title: '无法读取导入文件',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPreviewLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader
        title="数据导入 / 导出与备份"
        description="数据始终保存在本地；导出文件不包含任何凭据信息。"
      />
      <CardBody className="space-y-5 pt-2">
        <div className="grid gap-4 md:grid-cols-safe-2">
          <div className="space-y-2">
            <h4 className="text-note font-semibold text-muted">导出</h4>
            <div className="flex flex-wrap gap-2">
              <a href={api.exportJsonUrl()} download onClick={download}>
                <Button size="sm" icon={<FileJson size={13} />}>
                  导出 JSON（完整数据）
                </Button>
              </a>
              <a href={api.exportCsvUrl()} download>
                <Button size="sm" icon={<FileSpreadsheet size={13} />}>
                  导出 CSV（表格）
                </Button>
              </a>
            </div>
            <p className="text-caption leading-5 text-subtle">
              JSON 包含条目、收藏、制作人员、系列关系与原始数据，可用于迁移或恢复；
              CSV 适合在 Excel / 表格工具中做二次分析。
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="text-note font-semibold text-muted">导入</h4>
            <div className="flex flex-wrap gap-2">
              <Button
                ref={importButtonRef}
                size="sm"
                icon={<Upload size={13} />}
                loading={previewLoading}
                disabled={previewLoading || busy !== null}
                onClick={() => fileInputRef.current?.click()}
              >
                选择 JSON 文件
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              disabled={previewLoading || busy !== null}
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <p className="text-caption leading-5 text-subtle">
              支持本工具导出的 JSON，以及 Bangumi 官方的收藏接口 JSON。
              导入只会新增或更新数据，不会删除本地已有条目。
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-note font-semibold text-muted">数据库备份</h4>
            <Button
              size="sm"
              icon={<DatabaseBackup size={13} />}
              loading={busy === 'backup'}
              onClick={async () => {
                setBusy('backup');
                try {
                  const result = await api.createBackup();
                  await refetchBackups();
                  toast.push({
                    tone: 'success',
                    title: '备份已创建',
                    description: result.backup.fileName,
                  });
                } catch (error) {
                  toast.push({
                    tone: 'error',
                    title: '备份失败',
                    description: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  setBusy(null);
                }
              }}
            >
              立即备份
            </Button>
          </div>
          {backups && backups.backups.length > 0 ? (
            <div className="max-h-[180px] overflow-y-auto rounded-[10px] border border-border">
              {backups.backups.map((item) => (
                <div
                  key={item.fileName}
                  className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-note last:border-b-0"
                >
                  <span className="min-w-0 truncate font-mono text-caption">{item.fileName}</span>
                  <span className="shrink-0 text-caption text-subtle">
                    {(item.sizeBytes / 1024 / 1024).toFixed(2)} MB · {formatDateTime(item.createdAt)}
                  </span>
                  <a href={api.backupUrl(item.fileName)} onClick={download} download className="shrink-0">
                    <Button size="sm" variant="ghost" icon={<Download size={13} />}>
                      下载
                    </Button>
                  </a>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-caption text-subtle">还没有备份文件。建议在批量修改数据前先备份一次。</p>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-note font-semibold text-muted">封面离线缓存</h4>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={<Image size={13} />}
              loading={coverStatus?.running}
              onClick={async () => {
                try {
                  await api.cacheCovers(5000);
                  await refetchCover();
                  toast.push({
                    tone: 'info',
                    title: '开始缓存封面',
                    description: '缓存完成后断网也能看到封面。',
                  });
                } catch (error) {
                  toast.push({
                    tone: 'error',
                    title: '无法开始缓存',
                    description: error instanceof Error ? error.message : String(error),
                  });
                }
              }}
            >
              {coverStatus?.running ? '正在缓存…' : '缓存全部封面'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={13} />}
              onClick={async () => {
                try {
                  const result = await api.clearCovers();
                  await refetchCover();
                  toast.push({ tone: 'success', title: `已清除 ${result.removed} 个封面文件` });
                } catch (error) {
                  toast.push({
                    tone: 'error',
                    title: '清除失败',
                    description: error instanceof Error ? error.message : String(error),
                  });
                }
              }}
            >
              清除缓存
            </Button>
            {coverStatus ? (
              <span className="text-caption text-subtle">
                已缓存 {formatNumber(coverStatus.cached)} / {formatNumber(coverStatus.total)}（
                {formatPercent(coverStatus.total > 0 ? coverStatus.cached / coverStatus.total : 0, 0)}）
                {(coverStatus.sizeBytes / 1024 / 1024).toFixed(1)} MB
              </span>
            ) : null}
          </div>
          {coverStatus?.lastError ? (
            <InlineNote tone="warning">最近一次缓存错误：{coverStatus.lastError}</InlineNote>
          ) : null}
        </div>

        <div className="space-y-2">
          <h4 className="text-note font-semibold text-muted">本地文件</h4>
          <div className="space-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-caption">
            <p>
              <span className="text-subtle">数据目录：</span>
              <span className="break-all font-mono">{config?.dataDir ?? '—'}</span>
            </p>
            <p>
              <span className="text-subtle">数据库文件：</span>
              <span className="break-all font-mono">{config?.dbPath ?? '—'}</span>
              {config ? ` （${(config.dbSizeBytes / 1024 / 1024).toFixed(2)} MB）` : ''}
            </p>
            <p className="text-subtle">
              配置文件（含 Token，已被 .gitignore 排除）：data/config.json
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon={<ShieldCheck size={13} />}
              loading={busy === 'integrity'}
              onClick={async () => {
                setBusy('integrity');
                try {
                  const result = await api.integrity();
                  setIntegrity(result.ok ? '数据库自检通过（ok）' : `自检结果：${result.result}`);
                } catch (error) {
                  setIntegrity(error instanceof Error ? error.message : String(error));
                } finally {
                  setBusy(null);
                }
              }}
            >
              运行数据库自检
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<HardDriveDownload size={13} />}
              onClick={() => void queryClient.invalidateQueries()}
            >
              刷新全部数据
            </Button>
          </div>
          {integrity ? <InlineNote tone="neutral">{integrity}</InlineNote> : null}
        </div>
      </CardBody>

      <Dialog
        returnFocusRef={importButtonRef}
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && busy !== 'import') {
            setPreview(null);
            setPendingPayload(null);
          }
        }}
        title="确认导入"
        description="导入前会校验数据格式，导入过程在单个事务中完成。"
        footer={
          <>
            <Button
              disabled={busy === 'import'}
              onClick={() => {
                setPreview(null);
                setPendingPayload(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={busy === 'import'}
              disabled={busy !== null}
              onClick={async () => {
                if (!pendingPayload || busy !== null) return;
                setBusy('import');
                try {
                  const result = await api.importApply(pendingPayload);
                  await queryClient.invalidateQueries();
                  toast.push({
                    tone: 'success',
                    title: '导入完成',
                    description: `新增条目 ${result.newSubjects} · 新增收藏 ${result.newCollections} · 更新收藏 ${result.updatedCollections}`,
                  });
                  setPreview(null);
                  setPendingPayload(null);
                } catch (error) {
                  const unknownResult = error instanceof ApiRequestError && error.code === 'network_error';
                  toast.push({
                    tone: unknownResult ? 'warning' : 'error',
                    title: unknownResult ? '无法确认导入结果' : '导入失败',
                    description: unknownResult
                      ? '与服务连接中断，导入可能已经提交。请刷新收藏库确认结果后再重试。'
                      : error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  setBusy(null);
                }
              }}
            >
              确认导入
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="space-y-3 text-note">
            <div className="grid grid-cols-safe-2 gap-3">
              {[
                { label: '识别格式', value: preview.detectedFormat },
                { label: '数据条数', value: formatNumber(preview.total) },
                { label: '新增条目', value: formatNumber(preview.newSubjects) },
                { label: '更新条目', value: formatNumber(preview.updatedSubjects) },
                { label: '新增收藏', value: formatNumber(preview.newCollections) },
                { label: '更新收藏', value: formatNumber(preview.updatedCollections) },
              ].map((item) => (
                <div key={item.label} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                  <p className="text-caption text-subtle">{item.label}</p>
                  <p className="mt-0.5 font-medium">{item.value}</p>
                </div>
              ))}
            </div>
            {preview.sampleTitles.length > 0 ? (
              <p className="text-caption text-subtle">
                示例：{preview.sampleTitles.join('、')}
              </p>
            ) : null}
            {preview.skipped > 0 ? (
              <InlineNote tone="warning">
                有 {preview.skipped} 条数据格式不符合预期，将被跳过（不会影响已有数据）。
              </InlineNote>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}
