import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn.js';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastContextValue {
  push: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { icon: ReactNode; accent: string }> = {
  success: { icon: <CheckCircle2 size={16} />, accent: 'text-success' },
  error: { icon: <XCircle size={16} />, accent: 'text-danger' },
  warning: { icon: <AlertTriangle size={16} />, accent: 'text-warning' },
  info: { icon: <Info size={16} />, accent: 'text-info' },
};

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      const duration = toast.durationMs ?? (toast.tone === 'error' ? 9000 : 4500);
      if (duration > 0) window.setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-3 z-[80] flex w-[min(calc(100vw-24px),380px)] flex-col gap-2 sm:bottom-5 sm:right-5">
        {toasts.map((toast) => {
          const tone = TONE_STYLES[toast.tone ?? 'info'];
          return (
            <div
              key={toast.id}
              role="status"
              className="material-pop animate-in pointer-events-auto flex items-start gap-3 rounded-card border border-border px-4 py-3"
            >
              <span className={cn('mt-0.5 shrink-0', tone.accent)}>{tone.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-note text-muted">{toast.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => remove(toast.id)}
                aria-label="关闭提示"
                className="shrink-0 rounded-[7px] p-1 text-subtle transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context) return context;
  // 未包裹 Provider 时退化为静默实现，避免组件树不完整时崩溃
  return { push: () => undefined };
}
