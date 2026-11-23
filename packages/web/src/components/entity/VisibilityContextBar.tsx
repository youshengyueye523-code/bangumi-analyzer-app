import type { EntityAnalysisHiddenContext } from '@bangumi-analyzer/shared';
import { InlineNote } from '../ui/feedback.js';
import { Segmented } from '../ui/form.js';

/**
 * v1.8 口径条：只在存在隐藏内容时渲染。
 * 切换是整页一次的（不逐 Metric），离开页面不记忆。
 */
export function VisibilityContextBar({
  hidden,
  visibility,
  onToggle,
  className,
}: {
  hidden: EntityAnalysisHiddenContext;
  visibility: 'visible' | 'real';
  onToggle?: (next: 'visible' | 'real') => void;
  className?: string;
}) {
  if (hidden.series === 0 && hidden.members === 0) return null;

  const scope =
    hidden.series > 0
      ? `${hidden.members} 个成员（来自 ${hidden.series} 个系列）`
      : `${hidden.members} 个成员`;
  const text =
    visibility === 'visible'
      ? `当前可见口径 · 已隐藏 ${scope}`
      : `完整数据口径 · 已包含 ${scope}的隐藏内容`;

  return (
    <InlineNote tone="neutral" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {text}
          <span className="text-subtle"> · 隐藏只作用于显示层，数据没有被删除</span>
        </span>
        {onToggle ? (
          <Segmented
            size="sm"
            value={visibility}
            options={[
              { value: 'visible', label: '当前可见' },
              { value: 'real', label: '完整数据' },
            ]}
            onChange={(next) => onToggle(next as 'visible' | 'real')}
          />
        ) : null}
      </div>
    </InlineNote>
  );
}
