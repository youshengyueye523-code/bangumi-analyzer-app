import { useCallback, useEffect, useState } from 'react';
import {
  ArchiveRestore,
  CheckCircle2,
  Download,
  FileJson,
  HardDrive,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button, MockTag, cx } from './ui';
import {
  getProductBridge,
  type BackupEntry,
  type IntegrityReport,
  type MaintenanceOverview,
  type UpdateCheckResult,
} from '../driver/product';
import { log, toast } from '../state/feedback';
import { prefs, usePrefs } from '../state/prefs';
import { playChime } from '../state/sound';
import { useFlow } from '../state/flow';

function fmtBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function MaintenancePanel() {
  const pb = getProductBridge();
  const p = usePrefs();
  const flow = useFlow();

  const [overview, setOverview] = useState<MaintenanceOverview | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [feedUrl, setFeedUrl] = useState<string>('');
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [selectedZip, setSelectedZip] = useState<string>('');
  const [updateStage, setUpdateStage] = useState<{ stage: string; message: string } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<BackupEntry | null>(null);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [removeProgram, setRemoveProgram] = useState(true);
  const [removeUserData, setRemoveUserData] = useState(false);
  const [confirmWipeData, setConfirmWipeData] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!pb) return;
    try {
      const [ov, bk, cs] = await Promise.all([pb.getMaintenanceOverview(), pb.listBackups(), pb.getCompanionState()]);
      setOverview(ov);
      setBackups(bk.backups ?? []);
      if (cs?.state?.updateFeedUrl && !feedUrl) setFeedUrl(cs.state.updateFeedUrl);
    } catch {
      /* ignore transient */
    }
  }, [pb, feedUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pb) return;
    return pb.onProductEvent((ev) => {
      if (ev.type === 'update-stage' && ev.payload && typeof ev.payload === 'object') {
        const pay = ev.payload as { stage?: string; message?: string };
        setUpdateStage({ stage: pay.stage ?? '', message: pay.message ?? '' });
      }
    });
  }, [pb]);

  const handleBackup = async () => {
    if (!pb) {
      toast('info', '仅正式桌面产品模式可用', '当前为 M1/Mock 演示模式。');
      return;
    }
    setBusy('backup');
    playChime('tap');
    try {
      const res = await pb.createBackup();
      if (res.error) {
        playChime('warn');
        toast('danger', '创建备份失败', res.error);
        return;
      }
      playChime('ok');
      log('ok', `已创建数据库快照备份：${res.backup?.fileName ?? ''}`);
      toast('success', '备份已创建', res.backup?.fileName);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (entry: BackupEntry) => {
    if (!pb) return;
    setBusy('restore');
    playChime('tap');
    try {
      const res = await pb.restoreBackup({ fileName: entry.fileName });
      if (res.error) {
        setConfirmRestore(null);
        playChime('warn');
        toast('danger', '恢复失败', res.error);
        return;
      }
      playChime('ok');
      log('ok', `已从 ${entry.fileName} 恢复（自动保留恢复前快照 ${res.preRestoreBackup ?? ''}）`);
      toast('success', '数据库恢复完成', `恢复前快照：${res.preRestoreBackup ?? '已保存'}`);
      await refresh();
      setConfirmRestore(null);
    } finally {
      setBusy(null);
    }
  };

  const handleIntegrity = async () => {
    if (!pb) {
      toast('info', '仅正式桌面产品模式可用', '请使用 Product Mode 启动以执行真实 SQLite 与校验自检。');
      return;
    }
    setBusy('integrity');
    playChime('tap');
    try {
      const rep = await pb.runIntegrityCheck();
      setIntegrity(rep);
      if (rep.ok) {
        playChime('ok');
        log('ok', '完整自检通过：程序校验与 SQLite PRAGMA integrity_check 均正常');
        toast('success', '完整性自检全部通过');
      } else {
        playChime('warn');
        log('warn', '完整性自检发现异常项，请查看维护详情');
        toast('warning', '发现待处理项', '请检查下方逐项自检结果');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleCheckFeed = async () => {
    if (!pb) return;
    setBusy('checkUpdate');
    playChime('tap');
    try {
      const res = await pb.checkUpdate({ manifestPath: feedUrl.trim() });
      if ((res as { error?: string }).error) {
        playChime('warn');
        setUpdateStage({ stage: 'download-failed', message: `检查更新源失败：${(res as { error?: string }).error}` });
        toast('danger', '检查更新源失败', (res as { error?: string }).error);
        return;
      }
      setUpdateCheck(res);
      if (res.latest?.zipPath) setSelectedZip(res.latest.zipPath);
      if (res.configured === false) {
        toast('info', '未配置远端发布源', res.message);
      } else if (res.updateAvailable) {
        playChime('ok');
        toast('info', `发现可用版本 ${res.latest?.version} (r${res.latest?.distributionRevision})`);
      } else {
        toast('success', '当前已是该发布源最新版本');
      }
    } finally {
      setBusy(null);
    }
  };

  const handlePickUpdate = async () => {
    if (!pb) return;
    const picked = await pb.pickUpdateZip();
    if (picked.canceled || !picked.path) return;
    if (picked.path.toLowerCase().endsWith('.json')) {
      setBusy('checkUpdate');
      try {
        const res = await pb.checkUpdate({ manifestPath: picked.path });
        if ((res as { error?: string }).error) {
          toast('danger', '清单解析失败', (res as { error?: string }).error);
          return;
        }
        setUpdateCheck(res);
        if (res.latest?.zipPath) setSelectedZip(res.latest.zipPath);
        toast(res.updateAvailable ? 'info' : 'success', res.updateAvailable ? '发现可用更新清单' : '版本已是最新');
      } finally {
        setBusy(null);
      }
    } else {
      setSelectedZip(picked.path);
      setUpdateCheck(null);
      toast('info', '已选定本地更新包', picked.path);
    }
  };

  const canApplyRemote = Boolean(updateCheck?.updateAvailable && updateCheck.latest?.packageUrl);
  const canApplyLocal = Boolean(selectedZip);

  const handleApplyUpdate = async () => {
    if (!pb || (!canApplyRemote && !canApplyLocal)) return;
    setBusy('update');
    setUpdateStage({ stage: 'prepare', message: canApplyRemote ? '正在从清单下载并核验更新包…' : '准备执行本地安全更新…' });
    playChime('tap');
    try {
      const res = await pb.applySafeUpdate(
        canApplyRemote
          ? { packageUrl: updateCheck!.latest!.packageUrl, expectedSha256: updateCheck!.latest!.sha256 }
          : { zipPath: selectedZip, expectedSha256: updateCheck?.latest?.sha256 },
      );
      if (res.ok) {
        playChime('cheer');
        setUpdateStage({ stage: 'done', message: '更新验证通过，用户 data/ 已完整保留。' });
        log('ok', '安全更新完成（旧数据已自动备份并保留）');
        toast('success', '更新已完成', '健康检查通过，用户数据完整保留。');
        setUpdateCheck(null);
        await refresh();
      } else if (res.downloadFailed) {
        playChime('warn');
        setUpdateStage({ stage: 'download-failed', message: `下载或 SHA-256 核验失败（${res.reason ?? 'UNKNOWN'}），未修改原程序。` });
        log('error', `更新下载核验失败：${res.reason ?? 'UNKNOWN'}`);
        toast('danger', '下载或核验失败', res.reason);
      } else {
        playChime('warn');
        setUpdateStage({
          stage: 'rolledback',
          message: `更新校验未通过（${res.reason ?? 'UNKNOWN'}），已自动回滚到上一可用版本！`,
        });
        log('warn', `更新触发自动回滚：${res.reason ?? 'UNKNOWN'}`);
        toast('warning', '已自动安全回滚', '未破坏原有程序或用户数据。');
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleExportDiag = async () => {
    if (!pb) {
      toast('info', '仅正式桌面产品模式可用');
      return;
    }
    setBusy('diag');
    try {
      const res = await pb.exportDiagnostics();
      if (res.exported) {
        playChime('ok');
        toast('success', '已导出脱敏诊断报告', '已自动屏蔽敏感路径与凭据信息。');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async () => {
    if (!pb) return;
    if (removeUserData && !confirmWipeData) {
      toast('warning', '请二次确认永久删除', '勾选下方确认项后才能清理用户 data/ 目录。');
      return;
    }
    setBusy('uninstall');
    try {
      const res = await pb.uninstallCompanion({
        removeProgramFiles: removeProgram,
        removeUserData,
      });
      if (res.error) {
        toast('danger', '卸载未能完成', res.error);
        return;
      }
      prefs.set({ firstRunCompleted: false });
      toast(
        'success',
        '卸载已完成',
        res.userDataPreserved ? '已保护并保留你的全部 Bangumi 数据库与备份。' : '程序与用户数据均已清理。',
      );
      flow.go('intro');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="board-pane maint-pane pop-in">
      {!pb && (
        <div className="banner banner-warn">
          <Wrench size={16} />
          <div>
            <b>维护与诊断中心</b>
            <span>
              当前处于 M1 独立包/Mock 视图；通过 Product Mode 启动安装版 Companion 后将操作真实本地备份、SQLite 自检与回滚更新。 <MockTag />
            </span>
          </div>
        </div>
      )}

      {/* 1. 概览指标 */}
      <div className="maint-stats">
        <div className="maint-stat">
          <span className="ms-k">当前版本</span>
          <b className="ms-v">{overview ? `${overview.version} (r${overview.distributionRevision})` : '2.0.0 (r3)'}</b>
        </div>
        <div className="maint-stat">
          <span className="ms-k">数据库体积</span>
          <b className="ms-v numeric">{overview ? fmtBytes(overview.dbSizeBytes) : '—'}</b>
        </div>
        <div className="maint-stat">
          <span className="ms-k">可用备份</span>
          <b className="ms-v numeric">{overview ? `${overview.backupCount} 份` : `${backups.length} 份`}</b>
        </div>
        <div className="maint-stat">
          <span className="ms-k">安装目录</span>
          <b className="ms-v truncate" title={overview?.installDir ?? p.installDir}>
            {overview?.installDir ?? p.installDir}
          </b>
        </div>
      </div>

      {/* 2. 备份与回滚 + 完整性自检 */}
      <div className="maint-grid">
        <div className="maint-card">
          <div className="mc-head">
            <span>
              <ArchiveRestore size={14} /> 数据库备份与安全回滚
            </span>
            <Button variant="secondary" size="sm" icon={<Download size={13} />} loading={busy === 'backup'} onClick={handleBackup} disabled={!pb}>
              立即备份
            </Button>
          </div>

          {confirmRestore && (
            <div className="maint-confirm pop-in">
              <div>
                <b>确认回滚到 {confirmRestore.fileName}？</b>
                <p>Companion 将先自动创建当前数据的安全快照，再停止服务并原子恢复，绝不丢失现状。</p>
              </div>
              <div className="mc-confirm-btns">
                <Button variant="ghost" size="sm" onClick={() => setConfirmRestore(null)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" loading={busy === 'restore'} onClick={() => handleRestore(confirmRestore)}>
                  确认安全恢复
                </Button>
              </div>
            </div>
          )}

          {backups.length === 0 ? (
            <p className="mc-empty">暂无快照。每次首次配置、恢复或安全更新前都会自动生成备份。</p>
          ) : (
            <ul className="maint-list">
              {backups.slice(0, 5).map((b) => (
                <li key={b.fileName} className="maint-item">
                  <div className="mi-main">
                    <code className="truncate">{b.fileName}</code>
                    <span>
                      {fmtBytes(b.sizeBytes)} · {new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!pb || busy !== null}
                    onClick={() => setConfirmRestore(b)}
                  >
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="maint-card">
          <div className="mc-head">
            <span>
              <ShieldCheck size={14} /> 完整性自检与诊断
            </span>
            <div className="mc-head-btns">
              <Button variant="ghost" size="sm" icon={<FileJson size={13} />} loading={busy === 'diag'} onClick={handleExportDiag} disabled={!pb}>
                导出诊断
              </Button>
              <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} loading={busy === 'integrity'} onClick={handleIntegrity} disabled={!pb}>
                运行自检
              </Button>
            </div>
          </div>

          {integrity && integrity.checks ? (
            <ul className="maint-checks">
              {(integrity.checks ?? []).map((c) => (
                <li key={c.id} className={cx('mc-check', c.ok ? 'ok' : 'fail')}>
                  {c.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <div>
                    <b>{c.label}</b>
                    <span>{c.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mc-empty">点击「运行自检」可一键核对 Analyzer 发行文件 SHA-256、SQLite PRAGMA integrity_check 及目录状态。</p>
          )}
        </div>
      </div>

      {/* 3. 安全更新与自动回滚 */}
      <div className="maint-card">
        <div className="mc-head">
          <span>
            <Upload size={14} /> 版本检查、安全更新与自动回滚
          </span>
          <div className="mc-head-btns">
            <Button variant="secondary" size="sm" onClick={handlePickUpdate} disabled={!pb || busy !== null}>
              本地包/清单 (.zip / .json)
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy === 'update'}
              disabled={!pb || (!canApplyRemote && !canApplyLocal) || busy !== null}
              onClick={handleApplyUpdate}
            >
              {canApplyRemote ? '下载并安全升级' : '执行安全更新'}
            </Button>
          </div>
        </div>
        <div className="maint-feed-row">
          <input
            type="url"
            className="maint-feed-input"
            placeholder="可选：输入已签名 HTTPS 更新清单地址 (manifest.json)，未配置则仅用本地离线更新包"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            disabled={!pb || busy !== null}
          />
          <Button variant="secondary" size="sm" loading={busy === 'checkUpdate'} disabled={!pb || busy !== null} onClick={handleCheckFeed}>
            检查更新源
          </Button>
        </div>
        {updateCheck && (
          <div className="maint-update-summary">
            {updateCheck.configured === false ? (
              <span>{updateCheck.message}</span>
            ) : updateCheck.updateAvailable && updateCheck.latest ? (
              <span>
                发现更新：<b>{updateCheck.latest.version} (r{updateCheck.latest.distributionRevision})</b>
                {updateCheck.latest.sha256 ? ` · SHA-256 ${updateCheck.latest.sha256.slice(0, 12)}…` : ''}
                {updateCheck.latest.notes ? ` · ${updateCheck.latest.notes}` : ''}
              </span>
            ) : (
              <span>
                当前 <b>{updateCheck.current.version} (r{updateCheck.current.distributionRevision})</b> 已是最新（源清单无更高修订）。
              </span>
            )}
          </div>
        )}
        <p className="mc-desc">
          更新全程自动保留 <code>data/</code> 用户数据并预先快照；下载包强制校验 SHA-256，新版本未通过完整性与 <code>/api/health</code> 校验将自动回滚。
          {selectedZip && (
            <>
              {' '}
              已选离线包：<code>{selectedZip}</code>
            </>
          )}
        </p>
        {updateStage && (
          <div className={cx('maint-stage-banner', (updateStage.stage === 'rollback' || updateStage.stage === 'rolledback' || updateStage.stage === 'download-failed') ? 'warn' : updateStage.stage === 'done' ? 'ok' : 'info')}>
            <b>[{updateStage.stage}]</b> {updateStage.message}
          </div>
        )}
      </div>

      {/* 4. 安全卸载（默认保护数据） */}
      <div className="maint-card maint-danger-zone">
        <div className="mc-head">
          <span>
            <Trash2 size={14} /> 卸载与数据保护
          </span>
          <Button variant="ghost" size="sm" onClick={() => setUninstallOpen((o) => !o)} disabled={!pb}>
            {uninstallOpen ? '收起' : '管理卸载选项'}
          </Button>
        </div>
        {uninstallOpen && (
          <div className="maint-uninstall pop-in">
            <label className="mu-check">
              <input type="checkbox" checked={removeProgram} onChange={(e) => setRemoveProgram(e.target.checked)} />
              <span>移除本地 Analyzer 程序文件与桌面快捷方式</span>
            </label>
            <label className="mu-check warn">
              <input
                type="checkbox"
                checked={removeUserData}
                onChange={(e) => {
                  setRemoveUserData(e.target.checked);
                  if (!e.target.checked) setConfirmWipeData(false);
                }}
              />
              <span>
                <HardDrive size={13} /> 同时永久删除 <code>data/</code> 下的收藏数据库、配置文件与备份（默认保留，强烈建议不勾选）
              </span>
            </label>
            {removeUserData && (
              <label className="mu-check danger">
                <input type="checkbox" checked={confirmWipeData} onChange={(e) => setConfirmWipeData(e.target.checked)} />
                <span>
                  <ShieldAlert size={13} /> 我已知晓删除后不可恢复，确认连同 Bangumi 数据库一并清除
                </span>
              </label>
            )}
            <div className="mu-actions">
              <Button variant="danger" size="sm" loading={busy === 'uninstall'} onClick={handleUninstall}>
                {removeUserData ? '执行完全卸载' : '卸载程序（保留全部用户数据）'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
