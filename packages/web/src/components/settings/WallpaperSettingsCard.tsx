import { useQueryClient } from "@tanstack/react-query";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { queryKeys } from "../../lib/queries.js";
import {
  blurLength,
  dragFocus,
  isPreviewDataUrl,
  loadImageSize,
  readWallpaperFile,
  wallpaperSizeNote,
  wallpaperSrc,
  WALLPAPER_ACCEPT,
  WALLPAPER_BLUR_MAX,
  WALLPAPER_DEFAULT,
  WALLPAPER_SIZE_HINT,
  type Size,
} from "../../lib/wallpaper.js";
import { Button } from "../ui/button.js";
import { Card, CardBody, CardHeader } from "../ui/card.js";
import { InlineNote } from "../ui/feedback.js";
import { SliderField } from "../ui/form.js";
import { useToast } from "../ui/toast.js";
import { useWallpaper } from "../layout/wallpaper.js";

/**
 * 设置 → 外观 → 背景。
 *
 * 编辑一律先进入预览态（背景强度 / 模糊度 / 构图 / 换图都会立即在整站生效），
 * 只有点「应用」才写正式配置；「取消」或离开本页都会回到已保存状态。
 * 图片在应用时才上传，因此取消预览不会在服务端留下任何痕迹。
 */
export function WallpaperSettingsCard() {
  const { applied, active, dirty, updatePreview, cancelPreview, finishApply } = useWallpaper();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; focusX: number; focusY: number } | null>(null);
  const [imageSize, setImageSize] = useState<Size | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const src = wallpaperSrc(active.image);

  // 离开本页时放弃未应用的预览，避免预览态泄漏到其他页面
  useEffect(() => () => cancelPreview(), [cancelPreview]);

  // 原图尺寸只用于把拖动距离换算成焦点百分比，拿不到就按默认手感处理
  useEffect(() => {
    if (!src) {
      setImageSize(null);
      return;
    }
    let alive = true;
    void loadImageSize(src).then((size) => {
      if (alive) setImageSize(size.width > 0 && size.height > 0 ? size : null);
    });
    return () => {
      alive = false;
    };
  }, [src]);

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file || busy) return;
    setError(null);
    try {
      updatePreview({ image: await readWallpaperFile(file) });
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "读取图片失败");
    }
  }

  async function apply(): Promise<void> {
    dragRef.current = null;
    setBusy(true);
    setError(null);
    try {
      // 预览用的本地图片在这里才真正落盘，取消预览不会产生任何文件
      const image = isPreviewDataUrl(active.image)
        ? (await api.uploadWallpaper(active.image)).image
        : active.image;
      const updated = await api.updateConfig({
        wallpaper: {
          image,
          focusX: active.focusX,
          focusY: active.focusY,
          blur: active.blur,
          strength: active.strength,
        },
      });
      queryClient.setQueryData(queryKeys.config, updated);
      finishApply();
      toast.push({
        tone: "success",
        title: image ? "背景已应用" : "已恢复无背景",
        description: image ? "所有页面共用这张背景，刷新后仍然保留。" : undefined,
      });
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "应用失败");
    } finally {
      setBusy(false);
    }
  }

  const smallImageNote = wallpaperSizeNote(imageSize);

  return (
    <Card>
      <CardHeader
        title="背景"
        description="全局背景板：所有页面共用同一张图。背景只负责氛围，文字与数据始终显示在稳定的面板上。"
        actions={
          dirty ? (
            <span className="text-caption text-warning">预览中 · 未应用</span>
          ) : (
            <span className="text-caption text-subtle">
              {applied.image ? "已应用" : "当前无背景"}
            </span>
          )
        }
      />
      <CardBody className="grid gap-4 pt-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <div
            ref={frameRef}
            role="img"
            aria-label={active.image ? "背景预览，可拖动调整构图" : "背景预览（尚未选择图片）"}
            data-testid="wallpaper-preview"
            onPointerDown={(event) => {
              if (busy || !active.image || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = {
                x: event.clientX,
                y: event.clientY,
                focusX: active.focusX,
                focusY: active.focusY,
              };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              const frame = frameRef.current;
              if (busy || !drag || !frame) return;
              const rect = frame.getBoundingClientRect();
              const next = dragFocus(
                { focusX: drag.focusX, focusY: drag.focusY },
                { x: event.clientX - drag.x, y: event.clientY - drag.y },
                { width: rect.width, height: rect.height },
                imageSize,
              );
              updatePreview({ focusX: next.focusX, focusY: next.focusY });
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
            // 预览框比例贴近真实的「内容区」（去掉侧栏与顶栏后的窗口），
            // 这样拖动预览与实际背景的构图手感一致
            className={`relative aspect-[16/10] w-full max-w-[560px] touch-none overflow-hidden rounded-[10px] border border-border bg-surface-2 ${
              active.image && !busy ? "cursor-grab active:cursor-grabbing" : ""
            }`}
          >
            {src ? (
              <>
                <div
                  className="wallpaper-image"
                  data-testid="wallpaper-preview-image"
                  style={{
                    backgroundImage: `url("${src}")`,
                    backgroundPosition: `${active.focusX}% ${active.focusY}%`,
                  }}
                />
                <div className="wallpaper-scrim" />
                <span className="pointer-events-none absolute bottom-2 left-2 rounded-[8px] border border-border bg-surface-solid/90 px-2 py-0.5 text-caption text-muted">
                  拖动调整构图
                </span>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                <p className="text-note text-muted">当前没有背景</p>
                <p className="text-caption text-subtle">选择一张图片后，所有页面都会使用它</p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={<ImagePlus size={13} />}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {active.image ? "更换背景" : "选择图片"}
            </Button>
            {active.image ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={13} />}
                disabled={busy}
                onClick={() => updatePreview({ image: "" })}
              >
                清除背景
              </Button>
            ) : null}
            {imageSize && active.image ? (
              <span className="text-caption numeric text-subtle">
                {imageSize.width}×{imageSize.height}
                {active.blur > 0 ? ` · 模糊 ${blurLength(active.blur)}` : ""}
              </span>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              disabled={busy}
              accept={WALLPAPER_ACCEPT}
              className="hidden"
              data-testid="wallpaper-file"
              onChange={(event) => {
                void pickFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>

          {smallImageNote ? (
            <p className="text-caption text-warning">{smallImageNote}</p>
          ) : null}
          {error ? <p className="text-caption text-danger">{error}</p> : null}
        </div>

        <div className="space-y-3">
          <SliderField
            label="背景强度"
            min={0}
            max={100}
            step={5}
            value={active.strength}
            disabled={busy}
            formatValue={(value) => `${value}%`}
            hint="背景在整个界面里的存在感。0% 几乎不可见，100% 最明显；面板会始终保持可读。"
            onChange={(value) => updatePreview({ strength: value })}
          />
          <SliderField
            label="模糊度"
            min={0}
            max={WALLPAPER_BLUR_MAX}
            value={active.blur}
            disabled={busy}
            formatValue={(value) => (value === 0 ? "关闭" : `${value} px`)}
            hint="只作用于背景图本身，不会模糊页面内容、卡片、表格或弹层。"
            onChange={(value) => updatePreview({ blur: value })}
          />

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
              onClick={() =>
                updatePreview({
                  focusX: WALLPAPER_DEFAULT.focusX,
                  focusY: WALLPAPER_DEFAULT.focusY,
                })
              }
            >
              居中构图
            </Button>
          </div>

          <InlineNote tone="neutral">{WALLPAPER_SIZE_HINT}</InlineNote>
        </div>
      </CardBody>
    </Card>
  );
}
