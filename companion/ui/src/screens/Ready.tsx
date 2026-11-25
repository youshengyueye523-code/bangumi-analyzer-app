import { useEffect } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Folder,
  AtSign,
  Sparkles,
  Clock,
  AlertTriangle,
  Home,
  Database,
  PartyPopper,
} from 'lucide-react';
import { Button, CountUp, MockTag, Switch, cx } from '../components/ui';
import { Mascot } from '../components/Mascot';
import { getProductBridge } from '../driver/product';
import { disarmAutoOpen, markColdAutoStartHandled } from '../state/autoLaunch';
import { useFlow } from '../state/flow';
import { prefs, usePrefs } from '../state/prefs';
import { fmtSec } from './Initialize';

export function ReadyScreen() {
  const flow = useFlow();
  const pb = getProductBridge();
  const p = usePrefs();
  const { draft } = flow;

  const persistSetup = () => {
    prefs.set({
      firstRunCompleted: true,
      installDir: draft.installDir,
      nickname: draft.account?.nickname ?? (p.nickname || '本地收藏家'),
      username: draft.account?.username ?? p.username,
      collections: draft.syncedCount || draft.account?.collections || p.collections,
      aiConfigured: Boolean(draft.ai),
      aiModel: draft.ai ? `${draft.ai.provider} · ${draft.ai.model}` : '',
      lastSyncAt: draft.account ? Date.now() : p.lastSyncAt,
    });
    if (pb) {
      void pb.finishFirstRun({
        collections: draft.syncedCount || draft.account?.collections || p.collections,
        skipIntro: p.skipIntro,
        autoStart: p.autoStart,
        autoOpen: p.autoOpen,
      });
    }
  };

  const enterAnalyzer = () => {
    persistSetup();
    markColdAutoStartHandled();
    disarmAutoOpen();
    flow.go('launch');
  };

  const goHome = () => {
    persistSetup();
    markColdAutoStartHandled();
    disarmAutoOpen();
    flow.go('home');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.altKey && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
        e.preventDefault();
        enterAnalyzer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const line = draft.account
    ? `全部安顿好啦，${draft.account.nickname}！${draft.syncedCount || draft.account.collections} 部作品已经就位，随时出发～`
    : '本地档案库已经准备就绪！随时可以进入 Analyzer，之后绑定账号也很方便～';

  const elapsedSec = Math.max(1, Math.round((draft.elapsedMs || 14000) / 1000));

  return (
    <section className="stage-page ready-page">
      <div className="ready-burst" aria-hidden>
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} style={{ ['--i' as string]: i }} />
        ))}
      </div>

      <div className="ready-shell">
        <div className="ready-card glass pop-in">
          <div className="ready-badge">
            <PartyPopper size={14} /> SETUP COMPLETE
            {!pb && <MockTag />}
          </div>

          <h1 className="ready-title">
            {draft.account ? (
              <>
                欢迎回家，<span>{draft.account.nickname}</span>
              </>
            ) : (
              '本地档案库已准备就绪'
            )}
          </h1>
          <p className="ready-sub">
            Bangumi Analyzer 已完成初始化。数据保存在这台电脑，断网也能正常浏览与分析。
          </p>

          <div className="ready-metrics">
            <div className="ready-metric">
              <Database size={16} />
              <div>
                <span className="rm-label">本地收藏条目</span>
                <b className="rm-val numeric">
                  <CountUp value={draft.syncedCount || draft.account?.collections || 0} />
                  <small> 部</small>
                </b>
              </div>
            </div>
            <div className="ready-metric">
              <Clock size={16} />
              <div>
                <span className="rm-label">初始化耗时</span>
                <b className="rm-val numeric">{fmtSec(elapsedSec)}</b>
              </div>
            </div>
            <div className="ready-metric">
              <CheckCircle2 size={16} className="tone-success" />
              <div>
                <span className="rm-label">本机服务</span>
                <b className="rm-val">已就绪</b>
              </div>
            </div>
          </div>

          <ul className="ready-summary">
            <li>
              <Folder size={15} />
              <span>安装位置</span>
              <code className="truncate">{draft.installDir}</code>
            </li>
            <li>
              <AtSign size={15} />
              <span>Bangumi 账号</span>
              <b>
                {draft.account
                  ? `${draft.account.nickname} (@${draft.account.username} · ${draft.account.tokenSet ? '含私有收藏' : '公开收藏'})`
                  : '暂未绑定（可稍后在设置中绑定）'}
              </b>
            </li>
            <li>
              <Sparkles size={15} />
              <span>AI 助手</span>
              <b>{draft.ai ? `${draft.ai.provider} · ${draft.ai.model}` : '未启用（不影响统计与画像证据）'}</b>
            </li>
          </ul>

          {draft.warnings.length > 0 && (
            <div className="banner banner-warn">
              <AlertTriangle size={16} />
              <div>
                <b>有 {draft.warnings.length} 项待补充</b>
                <span>{draft.warnings.join(' · ')}，可在恢复网络后在 Analyzer 或 Companion 首页补全。</span>
              </div>
            </div>
          )}

          <div className="ready-prefs">
            <Switch
              checked={p.autoStart}
              onChange={(v) => prefs.set({ autoStart: v })}
              label="以后打开 Companion 自动启动 Analyzer"
              desc="省去每次手动启动；仍可随时安全停止"
            />
            <Switch
              checked={p.skipIntro}
              onChange={(v) => prefs.set({ skipIntro: v })}
              label="下次跳过开场演出，直接进入日常面板"
              desc="可随时在首页或模拟控制台中重播"
            />
          </div>

          <div className="ready-actions">
            <Button
              variant="primary"
              size="xl"
              onClick={enterAnalyzer}
              trailing={<ArrowRight size={18} />}
              kbd="Enter"
            >
              进入 Analyzer
            </Button>
            <Button variant="secondary" size="xl" icon={<Home size={16} />} onClick={goHome}>
              前往 Companion 首页
            </Button>
          </div>
        </div>

        <div className={cx('ready-mascot')}>
          <Mascot variant="full" state="cheer" line={line} />
        </div>
      </div>
    </section>
  );
}
