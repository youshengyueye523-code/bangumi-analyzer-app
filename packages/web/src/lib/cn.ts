import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge 需要显式知道哪些 `text-*` 是**字号**工具类。
 *
 * 默认配置只认识内置字号（text-sm / text-lg …），遇到项目自定义的
 * `text-body` / `text-note` / `text-caption` / `text-card` / `text-metric` …
 * 会把它当成「文字颜色」。于是 `cn('text-body', 'text-muted')` 这类写法里
 * 字号会被静默丢弃，元素回退到继承字号 —— 这就是 Dashboard 数据文字
 * 看起来偏小、且「明明写了 text-note 却仍是 11px」的根因。
 *
 * 这里把项目的字号 token 显式登记为 font-size 组：字号与颜色各归其位，
 * 两者可以同时生效。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: ['metric', 'display', 'title', 'section', 'card', 'data', 'body', 'note', 'caption'],
        },
      ],
    },
  },
});

/** 合并 Tailwind class，后出现的同类样式优先生效。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
