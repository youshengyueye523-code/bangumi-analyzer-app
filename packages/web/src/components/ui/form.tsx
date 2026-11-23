import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { ChevronDown, Search, X } from 'lucide-react';
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn.js';
import { Dropdown, DropdownItem } from './overlay.js';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-[34px] w-full rounded-control border border-border bg-surface-2 px-2.5 text-body text-text',
          'placeholder:text-subtle transition-colors',
          'focus:border-ring focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring-soft',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function SearchInput({
  value,
  onValueChange,
  placeholder = '搜索…',
  className,
  inputClassName,
  autoFocus,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 需要更高 / 更矮的搜索框时只改高度，其余样式保持全站一致 */
  inputClassName?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search
        size={15}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"
      />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          'h-[34px] w-full rounded-control border border-border bg-surface-2 pl-8 pr-8 text-body text-text',
          'placeholder:text-subtle transition-colors',
          'focus:border-ring focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring-soft',
          '[&::-webkit-search-cancel-button]:hidden',
          inputClassName,
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onValueChange('')}
          aria-label="清空搜索"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-chip p-1 text-subtle transition-colors hover:bg-surface-3 hover:text-text active:bg-surface-3"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
  suffix,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-muted">{label}</span>
      <span className="relative">
        <input
          type="number"
          inputMode="numeric"
          value={value ?? ''}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') onChange(undefined);
            else {
              const parsed = Number(raw);
              onChange(Number.isFinite(parsed) ? parsed : undefined);
            }
          }}
          className={cn(
            'h-[30px] w-full rounded-control border border-border bg-surface-2 px-2 text-body',
            'transition-colors',
            'focus:border-ring focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring-soft',
            suffix && 'pr-8',
          )}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-caption text-subtle">
            {suffix}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function RangeField({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  formatValue = (v: number) => String(v),
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  formatValue?: (value: number) => string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-caption font-medium text-muted">{label}</span>
        <span className="text-caption numeric text-subtle">
          {formatValue(value[0])} – {formatValue(value[1])}
        </span>
      </div>
      <SliderPrimitive.Root
        className="relative flex h-4 w-full touch-none select-none items-center"
        min={min}
        max={max}
        step={step}
        value={value}
        onValueChange={(next) => onChange([next[0] ?? min, next[1] ?? max])}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-surface-3">
          <SliderPrimitive.Range className="absolute h-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={`${label} 最小值`}
          className="block size-3.5 rounded-full border border-border-strong bg-surface shadow-[var(--shadow-pill)] transition-transform hover:scale-110 active:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <SliderPrimitive.Thumb
          aria-label={`${label} 最大值`}
          className="block size-3.5 rounded-full border border-border-strong bg-surface shadow-[var(--shadow-pill)] transition-transform hover:scale-110 active:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </SliderPrimitive.Root>
    </div>
  );
}

/** 单值滑块：与 RangeField 同一套轨道 / 滑块规格，用于强度、模糊度这类单参数。 */
export function SliderField({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  formatValue = (v: number) => String(v),
  hint,
  disabled = false,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-caption font-medium text-muted">{label}</span>
        <span className="text-caption numeric text-subtle">{formatValue(value)}</span>
      </div>
      <SliderPrimitive.Root
        aria-label={label}
        className="relative flex h-4 w-full touch-none select-none items-center"
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        onValueChange={(next) => onChange(next[0] ?? min)}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-surface-3">
          <SliderPrimitive.Range className="absolute h-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={label}
          className="block size-3.5 rounded-full border border-border-strong bg-surface shadow-[var(--shadow-pill)] transition-transform hover:scale-110 active:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </SliderPrimitive.Root>
      {hint ? <p className="text-caption leading-4 text-subtle">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-body font-medium">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-note text-muted">{description}</p> : null}
      </div>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors',
          'data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-3',
        )}
      >
        <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-[var(--shadow-pill)] transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchPrimitive.Root>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-note font-medium text-muted">
        {label}
      </label>
      {children}
      {hint ? <p className="text-caption leading-4 text-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * 二级选择（下拉选择）统一实现。
 *
 * 与 `Segmented`、`Dropdown` 同属一套控件：展开层复用 `Dropdown` / `DropdownItem`
 * （`bg-surface` + `border-border` + `rounded-menu` + `shadow-pop` +
 * `data-[highlighted]:bg-surface-2` + 选中 ✓ 标记），因此深浅色主题、
 * 背景板系统变化时都会自动跟随，不会出现「控件是深色、展开层是白色」的割裂。
 *
 * 行为与原生 `<select>` 对齐：选项顺序 / 值 / 默认值完全由调用方决定；
 * 键盘（↑↓ 选择、Enter 确认、Esc 关闭、点击外部关闭）由 Radix 提供。
 */
export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  className,
  ariaLabel,
  id,
  disabled = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** 只用于覆盖高度 / 字号等外观，颜色与圆角继承统一 token */
  className?: string;
  ariaLabel?: string;
  /** 供 `<label htmlFor>` 关联，保持原生 select 的可点击标签行为 */
  id?: string;
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === value);
  const trigger = (
    <button
      type="button"
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        'inline-flex h-[34px] w-full max-w-full items-center justify-between gap-2 rounded-control border border-border bg-surface-2 px-2 text-body text-text',
        'transition-colors hover:border-border-strong active:bg-surface-3',
        'focus-visible:border-ring focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-soft',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span className="min-w-0 truncate-line">{current?.label ?? String(value)}</span>
      <ChevronDown size={14} className="shrink-0 text-subtle" />
    </button>
  );
  // 与原生 select 一致：disabled 时不挂载浮层，避免任何方式展开
  if (disabled) return trigger;
  return (
    <Dropdown
      align="start"
      trigger={trigger}
    >
      {options.map((option) => (
        <DropdownItem
          key={String(option.value)}
          selected={option.value === value}
          onSelect={() => onChange(option.value)}
        >
          {option.label}
        </DropdownItem>
      ))}
    </Dropdown>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  wrap = true,
}: {
  options: Array<{ value: T; label: ReactNode; count?: number; title?: string }>;
  value: T | T[] | undefined;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  /** 放在横向滚动容器里时设为 false，避免换行后无法滚动 */
  wrap?: boolean;
}) {
  const selected = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return (
    <div
      role="group"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5',
        wrap ? 'flex-wrap' : 'flex-nowrap',
        className,
      )}
    >
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip font-medium transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              size === 'sm' ? 'h-6 px-2 text-caption' : 'h-7 px-2.5 text-note',
              active
                ? 'bg-surface text-text shadow-[var(--shadow-pill)]'
                : 'text-muted hover:text-text active:bg-surface-3',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={cn('numeric text-caption', active ? 'text-subtle' : 'text-subtle')}>
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
