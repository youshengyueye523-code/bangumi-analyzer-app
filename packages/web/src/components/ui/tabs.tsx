import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      {children}
    </TabsPrimitive.Root>
  );
}

export function TabList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded-card border border-border bg-surface p-1',
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function TabTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        'rounded-control px-3 py-1.5 text-body font-medium text-muted transition-colors',
        'hover:text-text active:bg-surface-3',
        'data-[state=active]:bg-surface-2 data-[state=active]:text-text',
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Content value={value} className={cn('animate-in mt-5 outline-none', className)}>
      {children}
    </TabsPrimitive.Content>
  );
}
