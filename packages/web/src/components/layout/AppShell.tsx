import {
  BarChart3,
  Database,
  IdCard,
  Layers,
  LayoutDashboard,
  Menu,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn.js';
import { useDetailScrollPolicy } from '../../lib/detailScrollPolicy.js';
import { useConfig, useHealth } from '../../lib/queries.js';
import { syncThemeFromServerConfig } from '../../lib/theme.js';
import { Avatar } from '../ui/avatar.js';
import { GlobalSearch } from './GlobalSearch.js';
import { SyncButton } from './SyncButton.js';
import { ThemeToggle } from './ThemeToggle.js';
import { WallpaperLayer } from './wallpaper.js';

const NAV_ITEMS: Array<{ to: string; label: string; icon: ReactNode; end?: boolean }> = [
  { to: '/', label: '仪表盘', icon: <LayoutDashboard size={16} />, end: true },
  { to: '/library', label: '收藏库', icon: <Database size={16} /> },
  { to: '/analysis', label: '统计分析', icon: <BarChart3 size={16} /> },
  { to: '/series', label: '系列 / IP', icon: <Layers size={16} /> },
  { to: '/profile', label: '我的画像', icon: <Sparkles size={16} /> },
  { to: '/me', label: '个人资料', icon: <IdCard size={16} /> },
  { to: '/diagnostics', label: '数据中枢', icon: <ShieldCheck size={16} /> },
  { to: '/settings', label: '设置', icon: <Settings size={16} /> },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group relative flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-body font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-accent-soft text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3',
            )
          }
        >
          {({ isActive }) => (
            <>
              {/* 当前位置指示条：不依赖颜色也能看出当前页 */}
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-opacity',
                  isActive ? 'bg-accent opacity-100' : 'opacity-0',
                )}
              />
              <span className="shrink-0">{item.icon}</span>
              <span className="truncate-line">{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarFooter() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  /*
   * 用户身份区与「个人资料」页共用同一个数据源（GET /api/config 的
   * nickname / avatar），不额外维护状态：在 Profile 里改完昵称或头像，
   * React Query 的 config 缓存更新后这里会立刻一起变。
   */
  const nickname = config?.nickname?.trim() ?? '';
  const bangumiUsername = config?.username?.trim() ?? '';
  const displayName = nickname || bangumiUsername || '未命名用户';
  return (
    <Link
      to="/me"
      title={`个人资料：${displayName}`}
      className={cn(
        'mx-2 mb-2 flex items-center gap-2.5 rounded-control border border-border bg-surface-2 px-2.5 py-2',
        'transition-colors hover:border-border-strong hover:bg-surface-3',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Avatar src={config?.avatar || null} name={displayName} size="sm" />
      <div className="min-w-0 flex-1">
        <p
          className="truncate-line text-note font-medium"
          title={nickname && bangumiUsername ? `${nickname}（Bangumi @${bangumiUsername}）` : displayName}
        >
          {displayName}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-caption text-subtle">
          <span
            className={cn('size-1.5 shrink-0 rounded-full', config?.hasToken ? 'bg-success' : 'bg-warning')}
            aria-hidden
          />
          <span className="truncate-line">
            {config?.canDisconnectBangumi && !bangumiUsername ? '未绑定 Bangumi 账号' : config?.hasToken ? 'Token 已配置' : '仅公开收藏'}
          </span>
        </p>
        <p className="numeric mt-0.5 text-caption text-subtle">
          本地数据 {health?.collections ?? 0} 条 · v{health?.version ?? '—'}
        </p>
      </div>
    </Link>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { data: config, refetch: refetchConfig } = useConfig();
  // v1.8.2：任何「新进入 Detail」的导航都必须从顶部开始（成员锚点除外）
  useDetailScrollPolicy();

  useEffect(() => {
    syncThemeFromServerConfig(config?.theme);
  }, [config?.theme]);

  useEffect(() => {
    const syncRemoteConfig = () => {
      if (!document.hidden) void refetchConfig();
    };
    window.addEventListener('focus', syncRemoteConfig);
    document.addEventListener('visibilitychange', syncRemoteConfig);
    return () => {
      window.removeEventListener('focus', syncRemoteConfig);
      document.removeEventListener('visibilitychange', syncRemoteConfig);
    };
  }, [refetchConfig]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen">
      {/* 全局背景板：负层级，位于画布底色之上、所有内容之下 */}
      <WallpaperLayer />
      {/* 悬浮材质：侧栏浮在内容之上，用方向性阴影 + 玻璃替代 1px 硬边框 */}
      <aside className="material-float sticky top-0 hidden h-screen w-[220px] shrink-0 flex-col shadow-[var(--shadow-side)] lg:flex">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-accent text-body font-bold text-[color:var(--accent-fg)]">
            B
          </span>
          <div className="min-w-0">
            <p className="truncate-line text-body font-semibold">动画数据库</p>
            <p className="truncate-line text-caption text-subtle">Bangumi Analyzer</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <NavItems />
        </div>
        <SidebarFooter />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button
            type="button"
            aria-label="关闭导航"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="material-float animate-in absolute inset-y-0 left-0 flex w-[240px] flex-col shadow-[var(--shadow-side)]">
            <div className="flex items-center justify-between px-4 py-4">
              <span className="text-body font-semibold">动画数据库</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="关闭"
                className="rounded-[7px] p-1 text-subtle hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <NavItems onNavigate={() => setMobileOpen(false)} />
            </div>
            <SidebarFooter />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="material-float sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 px-3 shadow-[var(--shadow-top)] lg:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="打开导航"
            className="shrink-0 rounded-[9px] p-2 text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <Menu size={16} />
          </button>
          <GlobalSearch />
          <div className="flex-1" />
          <SyncButton />
          <ThemeToggle />
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-4 sm:px-4 lg:px-6 lg:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
