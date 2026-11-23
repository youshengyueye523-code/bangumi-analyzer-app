import { useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Camera,
  CircleAlert,
  Database,
  IdCard,
  RefreshCw,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AVATAR_MAX_BYTES, type AppConfigPublic } from '@bangumi-analyzer/shared';
import { Avatar } from '../components/ui/avatar.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader, SectionTitle } from '../components/ui/card.js';
import { ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { Field, Input } from '../components/ui/form.js';
import { Dialog } from '../components/ui/overlay.js';
import { useToast } from '../components/ui/toast.js';
import { api } from '../lib/api.js';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format.js';
import { queryKeys, useConfig, useHealth, useLocalProfile, useSyncController } from '../lib/queries.js';

/** 文件大小 / 格式提示统一在这里生成，避免和设置页出现两套说法。 */
function readAvatarFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(`「${file.name}」不是图片文件（当前类型：${file.type || '未知'}）`));
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      reject(new Error('仅支持 PNG / JPEG / WebP / GIF 格式'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      reject(
        new Error(`图片过大（${(file.size / 1024 / 1024).toFixed(2)} MB），请压缩到 2 MB 以内`),
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function ProfileEditor({
  config,
  open,
  onOpenChange,
}: {
  config: AppConfigPublic;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [nickname, setNickname] = useState(config.nickname);
  const [avatar, setAvatar] = useState(config.avatar);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    try {
      setAvatar(await readAvatarFile(file));
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : '读取图片失败');
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateConfig({ nickname: nickname.trim(), avatar });
      queryClient.setQueryData(queryKeys.config, updated);
      await queryClient.invalidateQueries({ queryKey: queryKeys.localProfile });
      toast.push({ tone: 'success', title: '本地资料已保存' });
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="编辑本地资料"
      description="昵称与头像只保存在本机 data/config.json，不会同步到 Bangumi，也不会发送给任何第三方服务。"
      width={520}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            保存资料
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar src={avatar || null} name={nickname} size="lg" />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Camera size={13} />}
              onClick={() => fileRef.current?.click()}
            >
              选择图片
            </Button>
            {avatar ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={13} />}
                onClick={() => setAvatar('')}
              >
                移除头像
              </Button>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                void pickFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
        </div>
        <p className="text-caption text-subtle">
          支持 PNG / JPEG / WebP / GIF，单张不超过 2 MB。图片直接存进本机数据库目录，不会上传。
        </p>

        <Field label="昵称" htmlFor="nickname" hint="留空时界面会显示 Bangumi 用户名。">
          <Input
            id="nickname"
            value={nickname}
            maxLength={40}
            placeholder="例如：深夜补番的人"
            onChange={(event) => setNickname(event.target.value)}
          />
        </Field>

        {error ? <InlineNote tone="warning">{error}</InlineNote> : null}
      </div>
    </Dialog>
  );
}

function OnboardingSteps() {
  const { data, isLoading, error, refetch } = useLocalProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const expanded = searchParams.get('onboarding') === 'show';
  const changeExpanded = (open: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (open) next.set('onboarding', 'show'); else next.delete('onboarding');
    setSearchParams(next, { replace: true });
  };
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading || !data) return null;
  const allDone = data.steps.every(step => step.done);
  const onboarding = data;
  if (data.completed && !expanded) {
    return <Button size="sm" variant="ghost" onClick={() => changeExpanded(true)}>展开开始使用引导</Button>;
  }
  async function collapse(): Promise<void> {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // 跳过仅保存展示偏好，不改变任何步骤、同步历史或本地收藏。
      if (!onboarding.completed) {
        const config = await api.updateConfig({ onboardingSeen: true });
        queryClient.setQueryData(queryKeys.config, config);
        queryClient.setQueryData(queryKeys.localProfile, { ...onboarding, seen: true, completed: true });
      }
      changeExpanded(false);
    } catch (saveError) {
      toast.push({ tone: 'error', title: '无法收起引导', description: saveError instanceof Error ? saveError.message : String(saveError) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader
        title="开始使用"
        description="步骤只记录实际完成情况；可以跳过引导，已有本地数据的离线功能不受影响，也可随时重新展开。"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" loading={saving} onClick={() => void collapse()}>
              {allDone || data.seen ? '收起引导' : '暂时跳过'}
            </Button>
            <Link to="/settings?tab=bangumi">
              <Button size="sm" icon={<SettingsIcon size={13} />}>
                打开设置
              </Button>
            </Link>
          </div>
        }
      />
      <CardBody className="pt-2">
        <ol className="grid gap-2 sm:grid-cols-safe-3">
          {data.steps.map((step, index) => (
            <li
              key={step.id}
              className="flex items-start gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5"
            >
              <span
                className={
                  step.done
                    ? 'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success-soft text-caption font-semibold text-success'
                    : 'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-caption font-semibold text-subtle'
                }
              >
                {step.done ? '✓' : index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-note font-medium">{step.title}</p>
                <p className="mt-0.5 text-caption text-subtle">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

/**
 * 个人资料 = 身份 + 账号关联 + 应用状态。
 * 这里刻意不放任何动画统计（那属于仪表盘 / 画像），只回答「我是谁、数据在哪、同没同步」。
 */
export function MePage() {
  const configQuery = useConfig();
  const { data: health } = useHealth();
  const { status } = useSyncController();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  const config = configQuery.data;

  if (configQuery.error) {
    return <ErrorState error={configQuery.error} onRetry={() => void configQuery.refetch()} />;
  }
  if (configQuery.isLoading || !config) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[132px]" />
        <div className="grid gap-4 lg:grid-cols-safe-2">
          <Skeleton className="h-[220px]" />
          <Skeleton className="h-[220px]" />
        </div>
      </div>
    );
  }

  const displayName = config.nickname.trim() || config.username || '未命名用户';
  const lastSync = status?.lastSuccessfulSyncAt ?? null;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="个人资料"
        description="这个本地数据库的身份信息与当前状态；动画统计请查看仪表盘与我的画像。"
        actions={
          <Button size="sm" icon={<IdCard size={13} />} onClick={() => setEditing(true)}>
            编辑资料
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-4 p-5">
          <Avatar src={config.avatar || null} name={displayName} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="text-title">{displayName}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-note text-muted">
              <span>
                Bangumi 账号：
                {config.username ? `@${config.username}` : '未配置'}
              </span>
              {config.canDisconnectBangumi && !config.username ? <Badge tone="neutral">未绑定 Bangumi 账号</Badge> : config.hasToken ? (
                <Badge tone="success">
                  <BadgeCheck size={10} /> Token 已配置
                </Badge>
              ) : (
                <Badge tone="warning">仅公开收藏</Badge>
              )}
            </p>
            {config.nickname.trim() ? (
              <p className="mt-1 text-caption text-subtle">
                昵称是本机资料，与 Bangumi 账号资料互不影响。
              </p>
            ) : null}
          </div>
        </div>
      </Card>

      <OnboardingSteps />

      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card>
          <CardHeader
            title="账号关联"
            description="凭据只保存在本机，界面与接口都不会回显明文 Token"
            actions={
              <Link to="/settings?tab=bangumi">
                <Button size="sm">管理</Button>
              </Link>
            }
          />
          <CardBody className="space-y-2 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <span className="text-note text-muted">用户名</span>
              <span className="min-w-0 truncate-line text-note font-medium">
                {config.username || '未配置'}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <span className="text-note text-muted">Access Token</span>
              <span className="numeric text-note font-medium">
                {config.hasToken ? (config.tokenHint ?? '已配置') : '未配置'}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <span className="text-note text-muted">同步的条目类型</span>
              <span className="text-note font-medium">
                {config.subjectTypes.length === 1 ? '仅动画' : `全部 ${config.subjectTypes.length} 种`}
              </span>
            </div>
            <InlineNote tone="neutral">
              本工具不会读取或修改你的 Bangumi 账号资料，只在同步时按用户名拉取收藏列表。
            </InlineNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="数据状态"
            description="本地数据库的位置、容量与最近一次同步结果"
            actions={
              <Link to="/settings?tab=data">
                <Button size="sm">数据管理</Button>
              </Link>
            }
          />
          <CardBody className="space-y-2 pt-2">
            <div className="grid grid-cols-safe-2 gap-2">
              <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                <p className="text-caption text-subtle">本地收藏</p>
                <p className="numeric mt-0.5 text-section">{formatNumber(health?.collections ?? 0)}</p>
              </div>
              <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                <p className="text-caption text-subtle">条目总数</p>
                <p className="numeric mt-0.5 text-section">{formatNumber(health?.subjects ?? 0)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <span className="text-note text-muted">最近同步</span>
              <span className="text-note font-medium" title={lastSync ?? undefined}>
                {lastSync ? formatRelative(lastSync) : '尚未同步'}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <span className="text-note text-muted">数据库</span>
              <span className="min-w-0 truncate-line text-caption text-subtle" title={config.dbPath}>
                {config.dbPath}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <span className="text-note text-muted">应用版本</span>
              <span className="numeric text-note font-medium">v{health?.version ?? config.version}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                icon={<RefreshCw size={13} />}
                onClick={async () => {
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: queryKeys.health }),
                    queryClient.invalidateQueries({ queryKey: queryKeys.config }),
                    queryClient.invalidateQueries({ queryKey: queryKeys.localProfile }),
                  ]);
                  toast.push({ tone: 'info', title: '状态已刷新', description: `读取时间 ${formatDateTime(new Date().toISOString())}` });
                }}
              >
                刷新状态
              </Button>
              <Link to="/settings?tab=about">
                <Button size="sm" variant="ghost" icon={<CircleAlert size={13} />}>
                  安全与隐私
                </Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </div>

      <InlineNote tone="neutral">
        <span className="flex flex-wrap items-center gap-1.5">
          <Database size={13} className="shrink-0" />
          所有数据都保存在本机 {config.dataDir}；断网时除「同步」以外的功能全部可用。
        </span>
      </InlineNote>

      <ProfileEditor config={config} open={editing} onOpenChange={setEditing} />
    </div>
  );
}
