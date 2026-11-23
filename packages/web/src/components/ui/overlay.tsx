import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={220} skipDelayDuration={120}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className="material-pop z-[90] max-w-[min(280px,calc(100vw-24px))] rounded-chip border border-border px-2.5 py-1.5 text-note text-text"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Popover({
  trigger,
  children,
  align = 'start',
  width,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  width?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={8}
          collisionPadding={12}
          /*
           * 传入 width 时同时放宽 max-width：
           * 否则「固定宽度子元素 + 560px 上限」会让内容比容器宽，
           * 而 overflow-y:auto 会把 overflow-x 计算成 auto，直接产生横向滚动条。
           */
          style={
            width
              ? {
                  width: `min(calc(100vw - 24px), ${width}px)`,
                  maxWidth: `min(calc(100vw - 24px), ${width}px)`,
                }
              : undefined
          }
          className={cn(
            'z-[85] max-h-[min(70vh,560px)] max-w-[min(560px,calc(100vw-24px))]',
            // 只允许纵向滚动：横向必须由内容自身不超宽来保证（不是靠隐藏滚动条）
            'overflow-y-auto overflow-x-hidden overscroll-contain',
            'material-pop rounded-card border border-border p-4',
            'shadow-[var(--shadow-pop)] outline-none',
            'data-[state=open]:animate-in',
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 560,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  returnFocusRef?: { readonly current: HTMLElement | null };
}) {
  // Controlled dialogs have no Radix Trigger; remember the actual opener.
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[95] bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          onOpenAutoFocus={() => {
            previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
              // Async openers may have been disabled while reading a preview.
              const target = returnFocusRef?.current ?? previousFocus.current;
            if (target?.isConnected && target !== document.body) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
          style={{ width: `min(calc(100vw - 24px), ${width}px)` }}
          className={cn(
            'fixed left-1/2 top-1/2 z-[96] flex max-h-[calc(100vh-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'material-pop rounded-card border border-border p-5 outline-none',
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-section">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-note text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              aria-label="关闭"
              className="shrink-0 rounded-[7px] p-1 text-subtle transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={15} />
            </DialogPrimitive.Close>
          </div>
          {/* 内容区独立滚动：标题与按钮始终可见，弹窗永远不会溢出视口 */}
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {footer ? (
            <div className="mt-5 flex shrink-0 flex-wrap justify-end gap-2 border-t border-border pt-4">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Dropdown({
  trigger,
  children,
  align = 'end',
  contentClassName,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Optional surface override; the default uses the app's material surface. */
  contentClassName?: string;
}) {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={10}
          className={cn(
            'z-[88] max-h-[min(70vh,520px)] min-w-[190px] max-w-[min(320px,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-menu border border-border p-1',
            contentClassName ?? 'material-pop',
          )}
        >
          {children}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  tone = 'default',
  selected,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
  selected?: boolean;
  className?: string;
}) {
  return (
    <DropdownPrimitive.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-chip px-2.5 py-1.5 text-body outline-none transition-colors',
        tone === 'danger'
          ? 'text-danger data-[highlighted]:bg-danger-soft active:bg-danger-soft'
          : 'text-text data-[highlighted]:bg-surface-2 active:bg-surface-3',
        selected && 'font-medium',
        className,
      )}
    >
      {icon ? <span className="shrink-0 text-subtle">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate-line">{children}</span>
      {selected ? <span className="shrink-0 text-caption text-accent">✓</span> : null}
    </DropdownPrimitive.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownPrimitive.Label className="px-2.5 py-1 text-caption font-medium text-subtle">
      {children}
    </DropdownPrimitive.Label>
  );
}
