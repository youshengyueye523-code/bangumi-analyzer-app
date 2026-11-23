import type { MascotState } from '../../components/Mascot';

/** Logical canvas coordinates from Ariakage/live2d-agent-kit/examples/pink-sakura/preview-config.json */
export const PINK_SAKURA_DRAWING = {
  width: 1024,
  height: 1536,
} as const;

export const PINK_SAKURA_REGIONS = {
  full: { x: 38, y: 0, w: 920, h: 1536 },
  half: { x: 112, y: 0, w: 780, h: 760 },
  face: { x: 306, y: 0, w: 390, h: 365 },
} as const;

export interface PinkSakuraStateAction {
  motionGroup: string;
  fallbackMotionGroup?: string;
  expression: string;
  loopMotion: boolean;
  /** True when the motion lifts the viewer-left arm and needs GestureHandoff reset before switching */
  usesArmGesture?: boolean;
  mappingNote: string;
}

/**
 * Companion 8-state interface -> Pink Sakura 14 motions & 8 expressions.
 * Note: Pink Sakura has no dedicated `Worry` expression; `worry` approximates via `Shake` + `Surprised`.
 */
export const PINK_SAKURA_STATE_MAP: Record<MascotState, PinkSakuraStateAction> = {
  idle: {
    motionGroup: 'Idle',
    fallbackMotionGroup: 'Quiet',
    expression: 'SoftSmile',
    loopMotion: true,
    mappingNote: '原生 Idle + SoftSmile',
  },
  greet: {
    motionGroup: 'Wave',
    fallbackMotionGroup: 'Nod',
    expression: 'Smile',
    loopMotion: false,
    usesArmGesture: true,
    mappingNote: '原生 Wave 招手 + Smile',
  },
  think: {
    motionGroup: 'HandToChin',
    fallbackMotionGroup: 'Curious',
    expression: 'Smug',
    loopMotion: false,
    usesArmGesture: true,
    mappingNote: '原生 HandToChin 托下巴 + Smug',
  },
  work: {
    motionGroup: 'SpeechBob',
    fallbackMotionGroup: 'Nod',
    expression: 'SoftSmile',
    loopMotion: true,
    mappingNote: '原生 SpeechBob / Nod + SoftSmile',
  },
  happy: {
    motionGroup: 'FingerHeart',
    fallbackMotionGroup: 'Nod',
    expression: 'Smile',
    loopMotion: false,
    usesArmGesture: true,
    mappingNote: '原生 FingerHeart 比心 + Smile',
  },
  worry: {
    motionGroup: 'Shake',
    fallbackMotionGroup: 'Quiet',
    expression: 'Surprised',
    loopMotion: false,
    mappingNote: '近似组合：原生 Shake 轻摇头 + Surprised',
  },
  sleep: {
    motionGroup: 'Sleepy',
    fallbackMotionGroup: 'SlowBlink',
    expression: 'Sleepy',
    loopMotion: true,
    mappingNote: '原生 Sleepy + Sleepy 表情',
  },
  cheer: {
    motionGroup: 'FingerHeart',
    fallbackMotionGroup: 'Wave',
    expression: 'WinkLeft',
    loopMotion: false,
    usesArmGesture: true,
    mappingNote: '近似组合：原生 FingerHeart + WinkLeft',
  },
};
