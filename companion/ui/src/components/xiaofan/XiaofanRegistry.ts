/**
 * 原创站娘「小番 Xiaofan」规范化立绘与表情资产接入层
 *
 * 角色唯一身份基准：用户提供的原始粉发设定图「左侧全身立绘」（樱粉长发、TV 蝴蝶结发饰、
 * 科技感白粉短外套 + 深灰百褶短裙 + 工牌 + 腿环挂包 + 粉白短靴）。
 *
 * 资产投放约定（放入 companion/ui/src/assets/xiaofan/ 即可自动被 Vite 收录，无需改代码）：
 *   src/assets/xiaofan/illustration/full.png         全身透明立绘（欢迎页 / 完成页 / 全屏）
 *   src/assets/xiaofan/illustration/half.png         半身透明立绘（向导 / 日常首页）
 *   src/assets/xiaofan/expressions/<state>.png       8 态通用表情透明立绘（idle/greet/think/work/happy/worry/sleep/cheer）
 *   src/assets/xiaofan/expressions/full-<state>.png  全身分态覆盖（可选，优先级最高）
 *   src/assets/xiaofan/expressions/half-<state>.png  半身分态覆盖（可选，优先级最高）
 *
 * 注意：当前未放置正式透明 PNG 时自动回退到统一风格占位舞台；严禁从设定海报擅自抠图替代正式素材。
 */
import type { MascotState } from '../Mascot';

export type XiaofanVariant = 'full' | 'half';

export const XIAOFAN_IDENTITY = {
  name: '小番',
  en: 'Xiaofan',
  role: 'Bangumi Analyzer Companion 原创站娘',
  catchphrase: '一起把番剧生活整理得更有条理吧！',
  palette: {
    sakura: '#F9B6C8',
    rose: '#E76B8E',
    cream: '#FFF6F9',
    charcoal: '#4A3E4E',
    apricot: '#F6E4C8',
  },
} as const;

// 通过 import.meta.glob 静态扫描正式资产目录；未放入正式 PNG 时为空对象，构建零报错、运行零 404。
const BUNDLED_ASSETS = import.meta.glob('../../assets/xiaofan/**/*.{png,webp}', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function findAsset(suffixes: string[]): string | null {
  for (const suffix of suffixes) {
    const hit = Object.entries(BUNDLED_ASSETS).find(([k]) => k.toLowerCase().endsWith(suffix.toLowerCase()));
    if (hit) return hit[1];
  }
  return null;
}

export interface ResolvedXiaofanAsset {
  src: string | null;
  variant: XiaofanVariant;
  state: MascotState;
  slotPath: string;
  isFormal: boolean;
}

export function resolveXiaofanAsset(variant: XiaofanVariant, state: MascotState): ResolvedXiaofanAsset {
  const candidates = [
    `expressions/${variant}-${state}.png`,
    `expressions/${variant}-${state}.webp`,
    `expressions/${state}.png`,
    `expressions/${state}.webp`,
    `illustration/${variant}.png`,
    `illustration/${variant}.webp`,
  ];
  const src = findAsset(candidates);
  return {
    src,
    variant,
    state,
    slotPath: `assets/xiaofan/${variant === 'full' ? 'illustration/full.png' : 'illustration/half.png'}`,
    isFormal: Boolean(src),
  };
}
