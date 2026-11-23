import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FolderOpen, Folder, FileText, Database, HardDrive, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import { Button, Field, MockTag, Switch, cx } from '../components/ui';
import { StepFrame } from './SetupShell';
import { getProductBridge, type DirValidationResult } from '../driver/product';
import { DIR_SUGGESTIONS, validateInstallDir } from '../mock/setup';
import { useFlow } from '../state/flow';

export function InstallDirScreen() {
  const flow = useFlow();
  const pb = getProductBridge();
  const [path, setPath] = useState(flow.draft.installDir);
  const [picker, setPicker] = useState(false);
  const [shortcut, setShortcut] = useState(flow.draft.desktopShortcut ?? true);
  const [autorun, setAutorun] = useState(flow.draft.autoStart ?? false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const syncFallback = useMemo<DirValidationResult>(() => validateInstallDir(path), [path]);
  const [realVal, setRealVal] = useState<DirValidationResult | null>(null);

  useEffect(() => {
    if (!pb) return;
    let alive = true;
    const t = setTimeout(() => {
      pb.validateInstallDir({ rawPath: path })
        .then((res) => {
          if (alive) setRealVal(res);
        })
        .catch(() => {});
    }, 140);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pb, path]);

  const v = pb ? (realVal ?? syncFallback) : syncFallback;

  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicker(false);
    };
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPicker(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [picker]);

  useEffect(() => {
    if (v.level === 'error') flow.mascot('worry', '这个位置不太行……看看下面的原因？');
    else if (v.level === 'warn') flow.mascot('think', '能用，不过换个专用文件夹会更安心。');
    else flow.mascot('idle', '选一个专属文件夹，我和你的数据都会住在这里。');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.level]);

  const next = () => {
    if (v.level === 'error') return;
    flow.setDraft({ installDir: path.trim(), desktopShortcut: shortcut, autoStart: autorun });
    flow.next();
  };

  const browse = async () => {
    if (pb) {
      const picked = await pb.pickInstallDir();
      if (!picked.canceled && picked.path) setPath(picked.path);
      return;
    }
    setPicker((o) => !o);
  };
  const LevelIcon = v.level === 'ok' ? CheckCircle2 : v.level === 'warn' ? AlertTriangle : XCircle;
  const usedPct = v.freeGb ? Math.min(100, (0.35 / v.freeGb) * 100) : 0;

  return (
    <StepFrame
      no="02"
      en="INSTALL LOCATION"
      title="选择安装位置"
      desc="程序与数据库放在同一个专用文件夹里，迁移时整个文件夹带走即可。"
      onEnter={v.level !== 'error' ? next : undefined}
      footer={
        <>
          <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={flow.back}>
            上一步
          </Button>
          <div className="foot-spacer" />
          <Button variant="primary" size="lg" disabled={v.level === 'error'} onClick={next} trailing={<ArrowRight size={16} />} kbd={v.level !== 'error' ? 'Enter' : undefined}>
            使用此位置
          </Button>
        </>
      }
    >
      <div className="dir-row">
        <Field
          label="安装文件夹"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          prefix={<Folder size={15} />}
          spellCheck={false}
          className="dir-field"
        />
        <div className="picker-anchor" ref={pickerRef}>
          <Button variant="secondary" size="lg" icon={<FolderOpen size={15} />} onClick={browse}>
            浏览…
          </Button>
          {picker && !pb && (
            <div className="picker pop">
              <div className="picker-head">
                <span>选择文件夹</span>
                <MockTag>模拟系统对话框</MockTag>
                <button className="icon-btn" onClick={() => setPicker(false)}>
                  <X size={14} />
                </button>
              </div>
              {DIR_SUGGESTIONS.map((s) => {
                const lv = validateInstallDir(s.path).level;
                return (
                  <button
                    key={s.path}
                    className={cx('picker-item', `lv-${lv}`)}
                    onClick={() => {
                      setPath(s.path);
                      setPicker(false);
                    }}
                  >
                    <Folder size={14} />
                    <span className="picker-path">{s.path}</span>
                    <span className="picker-note">{s.note}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className={cx('verdict', `lv-${v.level}`)} key={v.level + v.title}>
        <LevelIcon size={18} />
        <div>
          <div className="verdict-title">{v.title}</div>
          {v.reasons.length > 0 && (
            <ul className="verdict-list">
              {v.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="dir-grid">
        <div className="mini-card">
          <div className="mini-head">
            <HardDrive size={14} /> 磁盘空间
          </div>
          {v.freeGb != null ? (
            <>
              <div className="disk-bar">
                <span style={{ width: `${Math.max(2, usedPct)}%` }} />
              </div>
              <div className="disk-meta">
                <span>
                  预计占用 <b>约 350 MB</b>
                </span>
                <span>
                  可用 <b className="numeric">{v.freeGb} GB</b>
                </span>
              </div>
              <p className="mini-note">数据库随收藏增长，通常每 1000 部作品约 20 MB（含封面缓存另计）。</p>
            </>
          ) : (
            <p className="mini-note">选择有效位置后显示。</p>
          )}
        </div>
        <div className="mini-card">
          <div className="mini-head">
            <Folder size={14} /> 将会创建
          </div>
          <ul className="tree">
            <li>
              <Folder size={13} /> {path.trim() || '…'}
            </li>
            <li className="t1">
              <Folder size={13} /> runtime <em>内置 Node 24</em>
            </li>
            <li className="t1">
              <Folder size={13} /> packages
            </li>
            <li className="t1">
              <Database size={13} /> data <em>收藏库 · 设置 · 备份</em>
            </li>
            <li className="t1">
              <FileText size={13} /> checksums.json
            </li>
          </ul>
        </div>
      </div>

      <div className="opt-group">
        <Switch
          checked={shortcut}
          onChange={setShortcut}
          label="创建桌面快捷方式"
          desc={pb ? '将在桌面创建「Bangumi Analyzer Companion」快捷方式' : '模拟：不会真的创建'}
        />
        <Switch checked={autorun} onChange={setAutorun} label="打开 Companion 时自动启动 Analyzer" desc="可在首页设置中随时更改" />
      </div>
    </StepFrame>
  );
}
