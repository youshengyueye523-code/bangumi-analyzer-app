import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-[color:var(--accent-fg)] hover:bg-accent-hover shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]',
  secondary:
    'bg-surface-2 text-text hover:bg-surface-3 active:bg-surface-3 border border-border hover:border-border-strong',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3',
  outline: 'border border-border-strong text-text hover:bg-surface-2 active:bg-surface-3',
  danger:
    'bg-danger-soft text-danger hover:bg-danger hover:text-white border border-transparent active:bg-danger',
};

/** 控件高度与 --control-sm/md/lg 一一对应，禁止在页面里覆写高度 */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-2.5 text-note gap-1.5 rounded-control',
  md: 'h-[34px] px-3 text-body gap-1.5 rounded-control',
  lg: 'h-[40px] px-4 text-body gap-2 rounded-control',
  icon: 'h-[34px] w-[34px] rounded-control justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading = false, icon, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center font-medium transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:pointer-events-none disabled:opacity-45',
        // 按下反馈：1px 下沉 + 极轻微压暗，让控件「被按到」，而不是只换颜色
        'active:translate-y-[0.5px] active:brightness-[0.97]',
        // 图标固定在 15px 视觉尺寸，避免不同页面各写一个 size
        '[&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonProps {
  label: string;
}

export function IconButton({ label, className, ...rest }: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      title={label}
      size="icon"
      variant="ghost"
      className={className}
      {...rest}
    />
  );
}
