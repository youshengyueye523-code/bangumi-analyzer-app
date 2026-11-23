import { UserRound } from 'lucide-react';
import { cn } from '../../lib/cn.js';

export type AvatarSize = 'sm' | 'md' | 'lg';

const SIZES: Record<AvatarSize, string> = {
  sm: 'size-8 text-[12px] rounded-[9px]',
  md: 'size-10 text-body rounded-[10px]',
  lg: 'size-14 text-title rounded-[14px]',
};

/**
 * 本地头像：只展示 data URL 或文字首字母，不发起任何网络请求。
 * 图片解码失败时回退到首字母，避免出现破图。
 */
export function Avatar({
  src,
  name,
  size = 'md',
  className,
}: {
  src?: string | null;
  name?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const label = (name ?? '').trim();
  // 纯数字用户 ID 直接取首字符会显示成一个孤零零的数字，改用通用图标
  const initial = label && !/^[\d\s_-]+$/.test(label) ? Array.from(label)[0]!.toUpperCase() : null;
  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden border border-border bg-surface-2 font-semibold text-muted select-none',
        SIZES[size],
        className,
      )}
      aria-hidden={src ? undefined : true}
    >
      {src ? (
        <img
          src={src}
          alt={label ? `${label} 的头像` : '本地头像'}
          className="size-full object-cover"
        />
      ) : initial === null ? (
        <UserRound size={size === 'lg' ? 22 : size === 'md' ? 16 : 14} aria-hidden />
      ) : (
        initial
      )}
    </span>
  );
}
