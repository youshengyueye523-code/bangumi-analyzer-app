import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import {
  MATERIAL_DEFAULT,
  MATERIAL_HINT,
  MATERIAL_NEEDS_WALLPAPER_HINT,
  MATERIAL_PRESET_LABEL,
  MATERIAL_PRESETS,
  matchingPreset,
  type MaterialPreset,
} from '../../lib/material.js';
import { queryKeys, useConfig } from '../../lib/queries.js';
import { useWallpaper } from '../layout/wallpaper.js';
import { useMaterial } from '../layout/material.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { InlineNote } from '../ui/feedback.js';
import { Segmented, SliderField } from '../ui/form.js';
import { useToast } from '../ui/toast.js';

const PRESET_OPTIONS = (Object.keys(MATERIAL_PRESETS) as MaterialPreset[]).map((preset) => ({
  value: preset,
  label: MATERIAL_PRESET_LABEL[preset],
}));

/**
 * 设置 → 外观 → 材质。
 *
 * 只暴露三个用户能理解的概念：材质倾向（清透 / 平衡 / 磨砂）+ 通透度 + 磨砂度。
 * 编辑先进入预览态，点「应用」才写正式配置（与相邻的「背景」卡片同一套交互）。
 */
export function MaterialSettingsCard() {
  const { applied, active, dirty, updatePreview, cancelPreview, finishApply } = useMaterial();
  const { applied: wallpaper } = useWallpaper();
  const { data: config } = useConfig();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 离开本页时放弃未应用的预览，避免预览态泄漏到其他页面
  useEffect(() => () => cancelPreview(), [cancelPreview]);

  const preset = matchingPreset(active);

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateConfig({
        material: { preset: active.preset, clarity: active.clarity, frosted: active.frosted },
      });
      queryClient.setQueryData(queryKeys.config, updated);
      finishApply();
      toast.push({ tone: 'success', title: '材质已应用' });
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : '应用失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="界面材质"
        description="侧栏、顶栏与浮层的玻璃质感；内容卡片仍然保持稳定，不受这里影响。"
        actions={
          dirty ? (
            <span className="text-caption text-warning">预览中 · 未应用</span>
          ) : (
            <span className="text-caption text-subtle">
              {matchingPreset(applied)
                ? `已应用 · ${MATERIAL_PRESET_LABEL[applied.preset]}`
                : '已应用 · 自定义'}
            </span>
          )
        }
      />
      <CardBody className="space-y-4 pt-2">
        <fieldset disabled={busy} className="min-w-0" aria-label="材质倾向">
          <Segmented<MaterialPreset | 'custom'>
            value={preset ?? 'custom'}
            options={PRESET_OPTIONS}
            onChange={(value) => {
              if (value === 'custom') return;
              updatePreview({ preset: value, ...MATERIAL_PRESETS[value] });
            }}
          />
        </fieldset>

        <div className="grid gap-4 md:grid-cols-safe-2">
          <SliderField
            label="通透度"
            min={0}
            max={100}
            step={5}
            value={active.clarity}
            disabled={busy}
            formatValue={(value) => `${value}%`}
            hint="越大越透：侧栏与浮层更能透出背景。"
            onChange={(value) => updatePreview({ clarity: value })}
          />
          <SliderField
            label="磨砂度"
            min={0}
            max={100}
            step={5}
            value={active.frosted}
            disabled={busy}
            formatValue={(value) => `${value}%`}
            hint="越大越模糊：背景被更强地雾化，细节更少。"
            onChange={(value) => updatePreview({ frosted: value })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            loading={busy}
            onClick={() => void apply()}
          >
            应用
          </Button>
          <Button
            size="sm"
            disabled={!dirty || busy}
            icon={<RotateCcw size={13} />}
            onClick={cancelPreview}
          >
            取消
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => updatePreview({ ...MATERIAL_DEFAULT })}
          >
            恢复平衡
          </Button>
        </div>

        {error ? <p className="text-caption text-danger">{error}</p> : null}
        <InlineNote tone="neutral">{MATERIAL_HINT}</InlineNote>
        {config && !wallpaper.image ? (
          <InlineNote tone="warning">{MATERIAL_NEEDS_WALLPAPER_HINT}</InlineNote>
        ) : null}
      </CardBody>
    </Card>
  );
}
