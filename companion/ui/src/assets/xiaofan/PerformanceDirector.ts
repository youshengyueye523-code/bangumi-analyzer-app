import type { MascotState } from '../../components/Mascot';
import {
  ARM_POSE_REST,
  ArmKinematicsController,
  type ArmHandForm,
  type ArmJointTarget,
} from './ArmRigRenderer';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

export interface CoreParamSink {
  setParameterValueById?: (id: string, value: number) => void;
  getParameterValueById?: (id: string) => number;
}

export type InteractionVariantId =
  | 'wave_hi'
  | 'finger_heart'
  | 'wink_cheer'
  | 'curious_chin'
  | 'gentle_nod'
  | 'playful_wink_left'
  | 'shy_glance';

export interface InteractionVariantSpec {
  id: InteractionVariantId;
  label: string;
  expression: string;
  durationSec: number;
  line: string;
}

export const INTERACTION_POOL: readonly InteractionVariantSpec[] = [
  {
    id: 'wave_hi',
    label: '热情招手',
    expression: 'Smile',
    durationSec: 2.6,
    line: '嗨～我一直都在这里陪着你哦！今天想先翻哪一部番的收藏？',
  },
  {
    id: 'finger_heart',
    label: '温暖比心',
    expression: 'Smile',
    durationSec: 2.5,
    line: '给你比个心！所有评分、标签和个人画像都安安静静保存在你的本机数据库里～',
  },
  {
    id: 'wink_cheer',
    label: '元气眨眼加油',
    expression: 'WinkRight',
    durationSec: 2.4,
    line: '补番加油呀！哪怕只是慢慢整理想看列表，也是很棒的仪式感呢✨',
  },
  {
    id: 'curious_chin',
    label: '俏皮歪头托腮',
    expression: 'Smug',
    durationSec: 2.5,
    line: '嗯哼？让我猜猜——你是准备去看年度趋势，还是去系列视图查缺补漏？',
  },
  {
    id: 'gentle_nod',
    label: '温柔点头致意',
    expression: 'SoftSmile',
    durationSec: 2.3,
    line: '收到～本地服务状态一切稳稳的，断网也能随时打开回顾你的动画档案。',
  },
  {
    id: 'playful_wink_left',
    label: '俏皮左眨眼',
    expression: 'WinkLeft',
    durationSec: 2.4,
    line: '偷偷告诉你，关闭浏览器标签不会停掉服务，点左侧「安全停止」才会让它安心休眠哦。',
  },
  {
    id: 'shy_glance',
    label: '微羞侧望微笑',
    expression: 'Smile',
    durationSec: 2.5,
    line: '诶、突然戳我一下……那我就再认真帮你看护好今天的收藏备份吧！',
  },
] as const;

export interface DirectorTelemetry {
  state: MascotState;
  armLift: number;
  armPose: number;
  handForm: number;
  armPhase: string;
  expression: string;
  shoulderDeg: number;
  elbowFlexDeg: number;
  wristDeg: number;
  handName: ArmHandForm;
  forearmInFront: boolean;
  activeInteraction: InteractionVariantId | null;
  lastInteraction: InteractionVariantId | null;
  interactionCount: number;
}

const HAND_INDEX: Record<ArmHandForm, number> = {
  rest: 0,
  chin: 1,
  heart: 2,
  wave: 3,
};

/**
 * Unified 8-state & ambient Live2D performance choreographer for Xiaofan (Pink Sakura).
 * Separates choreography cleanly into 4 non-competing layers:
 *   1. Ambient Idle Layer (breathing, natural irregular double-blinks, non-repeating gaze, gentle sway)
 *   2. 8-State Expressive Layer (distinct postures & expressions across all 8 companion states)
 *   3. Interactive Burst Layer (immediate click/poke feedback)
 *   4. Anatomical 2-Bone Arm Kinematics Layer (driven via ArmKinematicsController + split-cuff ArmRigRenderer)
 */
export class PerformanceDirector {
  private state: MascotState = 'idle';
  private stateElapsed = 0;
  private totalClock = 0;
  public readonly armRig = new ArmKinematicsController();

  // Smoothed continuous pose channels
  private cur: Record<string, number> = {
    ParamAngleX: 0,
    ParamAngleY: 0,
    ParamAngleZ: 0,
    ParamBodyAngleX: 0,
    ParamBodyAngleY: 0,
    ParamBodyAngleZ: 0,
    ParamShoulderLiftL: 0,
    ParamShoulderLiftR: 0,
    ParamChestExpand: 0,
    ParamWaistSway: 0,
    ParamEyeBallX: 0,
    ParamEyeBallY: 0,
    ParamFloat: 0,
    ParamWind: 0.2,
    ParamWindSway: 0,
  };

  // Non-repetitive idle glance & blink cadence
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private nextGazeShiftAt = 2.4;
  private blinkTimer = 0;
  private nextBlinkAt = 3.1;
  private doubleBlinkPending = false;

  // Independent transient randomized interaction state (never mutates Analyzer business state)
  private interactClock = -1;
  private interactDuration = 2.5;
  private activeInteraction: InteractionVariantId | null = null;
  private lastInteraction: InteractionVariantId | null = null;
  private interactionCount = 0;
  private recentInteracts: InteractionVariantId[] = [];
  private lastInteractAt = -10;
  private cheerCount = 0;
  private rng: () => number = Math.random;

  private activeExpression = 'SoftSmile';
  private expressionCallback?: (exp: string) => void;

  setRandomSource(fn: () => number) {
    this.rng = fn;
  }

  setExpressionHandler(fn: (exp: string) => void) {
    this.expressionCallback = fn;
  }

  getState(): MascotState {
    return this.state;
  }

  getTelemetry(): DirectorTelemetry {
    const lift = clamp(this.armRig.elbowFlexDeg / 145, 0, 1);
    const handName = this.armRig.activeHand;
    const poseIdx = handName === 'wave' ? 2 : handName === 'heart' ? 1 : 0;
    return {
      state: this.state,
      armLift: Number(lift.toFixed(2)),
      armPose: poseIdx,
      handForm: HAND_INDEX[handName],
      armPhase: this.armRig.elbowFlexDeg > 20 ? 'raised' : 'idle',
      expression: this.activeExpression,
      shoulderDeg: Number(this.armRig.abductDeg.toFixed(1)),
      elbowFlexDeg: Number(this.armRig.elbowFlexDeg.toFixed(1)),
      wristDeg: Number(this.armRig.wristDeg.toFixed(1)),
      handName,
      forearmInFront: this.armRig.elbowFlexDeg >= 24,
      activeInteraction: this.interactClock >= 0 ? this.activeInteraction : null,
      lastInteraction: this.lastInteraction,
      interactionCount: this.interactionCount,
    };
  }

  setState(next: MascotState) {
    if (next === this.state && this.stateElapsed > 0.2) return;
    this.state = next;
    this.stateElapsed = 0;
    if (next === 'cheer') this.cheerCount += 1;
    // Business state takes precedence cleanly without stuck interaction override
    if (this.interactClock < 0) {
      this.applyExpressionForState(next);
    }
  }

  /**
   * Triggers a transient randomized interaction without altering `this.state`.
   * Uses a recent-3 anti-repeat window across all 7 natural variants, instant response
   * (0.18s rapid-click guard), and clean retargeting with zero action stacking.
   */
  triggerInteract(forcedVariant?: InteractionVariantId): InteractionVariantSpec | null {
    if (!forcedVariant && this.totalClock - this.lastInteractAt < 0.18) {
      return this.activeInteraction
        ? (INTERACTION_POOL.find((v) => v.id === this.activeInteraction) ?? null)
        : null;
    }
    this.lastInteractAt = this.totalClock;

    let chosen: InteractionVariantSpec;
    if (forcedVariant) {
      chosen = INTERACTION_POOL.find((v) => v.id === forcedVariant) ?? INTERACTION_POOL[0]!;
    } else {
      const recentSet = new Set(this.recentInteracts);
      const candidates = INTERACTION_POOL.filter((v) => !recentSet.has(v.id));
      const pool = candidates.length > 0 ? candidates : INTERACTION_POOL;
      const idx = Math.floor(clamp(this.rng(), 0, 0.999999) * pool.length);
      chosen = pool[idx]!;
    }

    this.activeInteraction = chosen.id;
    this.lastInteraction = chosen.id;
    this.interactClock = 0;
    this.interactDuration = chosen.durationSec;
    this.interactionCount += 1;
    this.recentInteracts.push(chosen.id);
    if (this.recentInteracts.length > 3) {
      this.recentInteracts.shift();
    }
    this.emitExpression(chosen.expression);
    return chosen;
  }

  private emitExpression(exp: string) {
    if (this.activeExpression !== exp) {
      this.activeExpression = exp;
      this.expressionCallback?.(exp);
    }
  }

  private applyExpressionForState(st: MascotState) {
    const map: Record<MascotState, string> = {
      idle: 'SoftSmile',
      greet: 'Smile',
      think: 'Smug',
      work: 'SoftSmile',
      happy: 'Smile',
      worry: 'Surprised',
      sleep: 'Sleepy',
      cheer: this.cheerCount % 2 === 1 ? 'WinkLeft' : 'WinkRight',
    };
    this.emitExpression(map[st]);
  }

  /**
   * Called inside `internalModel.on('afterMotionUpdate')` so expressions & physics evaluate naturally on top.
   */
  applyAfterMotion(core: CoreParamSink | undefined, dtSec: number) {
    if (!core?.setParameterValueById) return;
    const dt = clamp(dtSec, 0, 0.08);
    this.totalClock += dt;
    this.stateElapsed += dt;

    // Update interactive burst expiry -> restore underlying business state cleanly
    if (this.interactClock >= 0) {
      this.interactClock += dt;
      if (this.interactClock >= this.interactDuration) {
        this.interactClock = -1;
        this.activeInteraction = null;
        this.applyExpressionForState(this.state);
      }
    }

    // Update non-repetitive gaze target
    if (this.totalClock >= this.nextGazeShiftAt) {
      const seed = Math.sin(this.totalClock * 12.9898) * 43758.5453;
      const fracA = seed - Math.floor(seed);
      const fracB = seed * 1.7 - Math.floor(seed * 1.7);
      if (this.state === 'work') {
        this.gazeTargetX = (fracA - 0.5) * 0.68;
        this.gazeTargetY = -0.22 + (fracB - 0.5) * 0.14;
        this.nextGazeShiftAt = this.totalClock + 1.6 + fracA * 1.8;
      } else if (this.state === 'think') {
        this.gazeTargetX = 0.22 + (fracA - 0.3) * 0.32;
        this.gazeTargetY = 0.16 + (fracB - 0.5) * 0.18;
        this.nextGazeShiftAt = this.totalClock + 2.4 + fracA * 2.2;
      } else if (this.state === 'worry') {
        this.gazeTargetX = (fracA - 0.5) * 0.55;
        this.gazeTargetY = -0.22 + (fracB - 0.5) * 0.12;
        this.nextGazeShiftAt = this.totalClock + 2.2 + fracA * 1.8;
      } else {
        this.gazeTargetX = (fracA - 0.5) * 0.48;
        this.gazeTargetY = (fracB - 0.45) * 0.26;
        this.nextGazeShiftAt = this.totalClock + 3.0 + fracA * 3.2;
      }
    }

    const t = this.stateElapsed;
    const g = this.totalClock;
    const targets: Record<string, number> = {
      ParamAngleX: 0,
      ParamAngleY: 0,
      ParamAngleZ: 0,
      ParamBodyAngleX: 0,
      ParamBodyAngleY: 0,
      ParamBodyAngleZ: 0,
      ParamShoulderLiftL: 0,
      ParamShoulderLiftR: 0,
      ParamChestExpand: 0,
      ParamWaistSway: 0,
      ParamEyeBallX: this.gazeTargetX,
      ParamEyeBallY: this.gazeTargetY,
      ParamFloat: Math.sin(g * 1.05) * 0.08,
      ParamWind: 0.22 + Math.sin(g * 0.68) * 0.11 + Math.sin(g * 1.33) * 0.04,
      ParamWindSway: Math.sin(g * 0.82) * 0.24,
    };

    let armTarget: ArmJointTarget = {
      ...ARM_POSE_REST,
      abductDeg: 19.3 + Math.sin(g * 0.38) * 1.3,
      wristDeg: Math.sin(g * 0.46) * 2.5,
    };
    let breathFreq = 0.27;
    let smoothRate = 6.5;

    if (this.interactClock >= 0 && this.activeInteraction) {
      const it = this.interactClock;
      smoothRate = 9.5;
      switch (this.activeInteraction) {
        case 'wave_hi':
          // Friendly raised greeting wave beside cheek (RC3 verified arm silhouette)
          targets.ParamAngleX = 5.5 + Math.sin(it * 2.2) * 2.2;
          targets.ParamAngleY = 3.2;
          targets.ParamAngleZ = 7.5 + Math.sin(it * 2.4) * 1.8;
          targets.ParamBodyAngleZ = 2.0;
          targets.ParamShoulderLiftR = 0.28;
          targets.ParamEyeBallX = 0;
          targets.ParamEyeBallY = 0.05;
          armTarget = {
            abductDeg: 38,
            shoulderFlexDeg: 12,
            elbowFlexDeg: 136,
            planeYawDeg: 40,
            wristDeg: 0,
            hand: 'wave',
            forearmWaveDeg: 9,
            waveAmpDeg: 16,
            waveHz: 1.5,
          };
          break;
        case 'finger_heart':
          // Warm nod + cozy finger-heart (RC3 verified pose)
          targets.ParamAngleY = Math.sin(it * Math.PI * 1.8) * 6.5;
          targets.ParamAngleZ = 6.2 * Math.sin(it * 2.0);
          targets.ParamBodyAngleY = 2.0 * Math.sin(it * 2.0);
          targets.ParamShoulderLiftL = 0.18;
          targets.ParamShoulderLiftR = 0.24;
          targets.ParamEyeBallX = 0;
          targets.ParamEyeBallY = 0.06;
          armTarget = {
            abductDeg: 22,
            shoulderFlexDeg: 16,
            elbowFlexDeg: 147,
            planeYawDeg: 15,
            wristDeg: -4,
            hand: 'heart',
          };
          break;
        case 'wink_cheer':
          // Bright right-eye wink + upbeat encouragement bounce + soft open-palm poise
          targets.ParamAngleX = -4.5 + Math.sin(it * 3.0) * 2.4;
          targets.ParamAngleY = 4.2 + Math.sin(it * 4.2) * 2.4;
          targets.ParamAngleZ = -6.8 + Math.sin(it * 2.6) * 2.0;
          targets.ParamBodyAngleY = 2.6 + Math.sin(it * 4.2) * 1.6;
          targets.ParamFloat = 0.16 + Math.sin(it * 4.2) * 0.1;
          targets.ParamShoulderLiftL = 0.22;
          targets.ParamShoulderLiftR = 0.3;
          targets.ParamEyeBallX = 0.05;
          targets.ParamEyeBallY = 0.08;
          armTarget = {
            abductDeg: 34,
            shoulderFlexDeg: 14,
            elbowFlexDeg: 126,
            planeYawDeg: 34,
            wristDeg: 4 + Math.sin(it * 3.6) * 5,
            hand: 'wave',
            forearmWaveDeg: 3,
            waveAmpDeg: 5,
            waveHz: 1.0,
          };
          break;
        case 'curious_chin':
          // Playful curious head tilt + chin-tap hand (RC3 verified pose)
          targets.ParamAngleX = -8.5;
          targets.ParamAngleY = 4.2;
          targets.ParamAngleZ = -9.5;
          targets.ParamBodyAngleX = -2.2;
          targets.ParamShoulderLiftR = 0.14;
          targets.ParamEyeBallX = -0.18;
          targets.ParamEyeBallY = 0.12;
          armTarget = {
            abductDeg: 6.5,
            shoulderFlexDeg: 20,
            elbowFlexDeg: 140,
            planeYawDeg: -35,
            wristDeg: 6,
            hand: 'chin',
          };
          break;
        case 'gentle_nod':
          // Relaxed natural double nod with arms comfortably at rest (no forced arm lift)
          targets.ParamAngleX = Math.sin(it * 1.6) * 2.6;
          targets.ParamAngleY = -2.0 + Math.sin(it * Math.PI * 1.9) * 8.2 * Math.exp(-it * 0.35);
          targets.ParamAngleZ = 4.2 * Math.sin(it * 1.8);
          targets.ParamBodyAngleY = 1.6 * Math.sin(it * Math.PI * 1.9) * Math.exp(-it * 0.4);
          targets.ParamChestExpand = 0.24 + Math.sin(it * 2.4) * 0.12;
          targets.ParamWind = 0.34 + Math.sin(it * 2.1) * 0.14;
          targets.ParamEyeBallX = 0;
          targets.ParamEyeBallY = 0.04;
          armTarget = {
            ...ARM_POSE_REST,
            abductDeg: 21.5 + Math.sin(it * 2.0) * 1.6,
            wristDeg: 4 + Math.sin(it * 2.0) * 3,
          };
          break;
        case 'playful_wink_left':
          // Playful left-eye wink + opposite tilt + sweeping attentive eye gaze (relaxed shoulders)
          targets.ParamAngleX = -6.0 + Math.sin(it * 1.9) * 3.0;
          targets.ParamAngleY = 2.6;
          targets.ParamAngleZ = 8.8 + Math.sin(it * 2.0) * 1.8;
          targets.ParamBodyAngleX = 2.2;
          targets.ParamBodyAngleZ = 2.4;
          targets.ParamShoulderLiftL = 0.2;
          targets.ParamEyeBallX = Math.sin(it * 2.2) * 0.24;
          targets.ParamEyeBallY = 0.08;
          armTarget = {
            ...ARM_POSE_REST,
            abductDeg: 23.0 + Math.sin(it * 2.4) * 2.0,
            wristDeg: -5 + Math.sin(it * 2.4) * 4,
          };
          break;
        case 'shy_glance':
          // Cute slight shy glance to the side with eyes looking back at user + gentle chin-near poise
          targets.ParamAngleX = 9.5;
          targets.ParamAngleY = -3.8;
          targets.ParamAngleZ = -5.5;
          targets.ParamBodyAngleX = 2.6;
          targets.ParamBodyAngleZ = -1.8;
          targets.ParamShoulderLiftL = 0.16;
          targets.ParamShoulderLiftR = 0.18;
          targets.ParamEyeBallX = -0.44;
          targets.ParamEyeBallY = 0.06;
          armTarget = {
            abductDeg: 9.0,
            shoulderFlexDeg: 18,
            elbowFlexDeg: 132,
            planeYawDeg: -28,
            wristDeg: 4,
            hand: 'chin',
          };
          break;
      }
    } else {
      switch (this.state) {
        case 'idle': {
          const beatCycle = g % 18;
          const ambientBeat = beatCycle > 12 && beatCycle < 15.2 ? Math.sin(((beatCycle - 12) / 3.2) * Math.PI) : 0;
          targets.ParamAngleX = Math.sin(g * 0.41) * 3.8 + Math.sin(g * 0.17) * 2.2;
          targets.ParamAngleY = Math.sin(g * 0.35) * 2.0 + ambientBeat * 3.2;
          targets.ParamAngleZ = Math.sin(g * 0.49) * 2.6 + ambientBeat * 4.2;
          targets.ParamBodyAngleX = Math.sin(g * 0.29) * 1.4;
          targets.ParamBodyAngleZ = Math.sin(g * 0.25) * 1.1;
          targets.ParamWaistSway = Math.sin(g * 0.33) * 0.16;
          targets.ParamChestExpand = 0.15 + Math.sin(g * breathFreq * Math.PI * 2) * 0.12;
          break;
        }
        case 'greet': {
          smoothRate = 8.2;
          const activeWave = t < 3.4;
          targets.ParamAngleX = activeWave ? 4.5 + Math.sin(t * 2.0) * 3.2 : Math.sin(g * 0.45) * 3;
          targets.ParamAngleY = activeWave ? 4.0 + Math.sin(t * 2.8) * 1.8 : 1.2;
          targets.ParamAngleZ = activeWave ? 7.0 + Math.sin(t * 2.2) * 2.2 : Math.sin(g * 0.5) * 2.4;
          targets.ParamBodyAngleY = activeWave ? 1.8 : 0.4;
          targets.ParamBodyAngleZ = activeWave ? 2.1 : 0.6;
          targets.ParamShoulderLiftR = activeWave ? 0.28 : 0;
          targets.ParamEyeBallX = activeWave ? 0 : this.gazeTargetX * 0.6;
          targets.ParamEyeBallY = activeWave ? 0.06 : this.gazeTargetY * 0.6;
          if (activeWave) {
            armTarget = {
              abductDeg: 38,
              shoulderFlexDeg: 12,
              elbowFlexDeg: 135,
              planeYawDeg: 40,
              wristDeg: 0,
              hand: 'wave',
              forearmWaveDeg: 8.5,
              waveAmpDeg: 15,
              waveHz: 1.35,
            };
          }
          break;
        }
        case 'think': {
          smoothRate = 7.4;
          const ponderNod = Math.sin(t * 0.85) > 0.85 ? -3.0 : 0;
          targets.ParamAngleX = -7.5 + Math.sin(t * 0.52) * 2.2;
          targets.ParamAngleY = 2.0 + ponderNod + Math.sin(t * 0.65) * 1.4;
          targets.ParamAngleZ = -7.2 + Math.sin(t * 0.42) * 1.6;
          targets.ParamBodyAngleX = -2.0;
          targets.ParamBodyAngleZ = -1.8 + Math.sin(t * 0.38) * 0.8;
          targets.ParamShoulderLiftL = -0.06;
          targets.ParamShoulderLiftR = 0.16;
          armTarget = {
            abductDeg: 6.5,
            shoulderFlexDeg: 20,
            elbowFlexDeg: 140,
            planeYawDeg: -35,
            wristDeg: 6 + Math.sin(t * 0.7) * 2.5,
            hand: 'chin',
          };
          break;
        }
        case 'work': {
          breathFreq = 0.25;
          const checkCycle = t % 4.6;
          const microNod = checkCycle < 0.7 ? -Math.sin((checkCycle / 0.7) * Math.PI) * 3.6 : 0;
          targets.ParamAngleX = Math.sin(t * 0.4) * 2.2;
          targets.ParamAngleY = -6.8 + microNod;
          targets.ParamAngleZ = 1.6 + Math.sin(t * 0.33) * 1.4;
          targets.ParamBodyAngleY = -2.4;
          targets.ParamBodyAngleZ = 1.0;
          targets.ParamShoulderLiftL = Math.sin(g * breathFreq * Math.PI * 2) * 0.08;
          targets.ParamShoulderLiftR = Math.sin(g * breathFreq * Math.PI * 2) * 0.08;
          targets.ParamChestExpand = 0.1 + Math.sin(g * breathFreq * Math.PI * 2) * 0.08;
          armTarget = { ...ARM_POSE_REST };
          break;
        }
        case 'happy': {
          smoothRate = 8.2;
          const showHeart = t < 3.8;
          const bounce = showHeart ? Math.abs(Math.sin(t * 2.5)) : Math.abs(Math.sin(t * 1.1)) * 0.3;
          targets.ParamAngleX = Math.sin(t * 1.7) * 5.2;
          targets.ParamAngleY = 2.8 + bounce * 3.2;
          targets.ParamAngleZ = Math.sin(t * 2.0) * 6.8;
          targets.ParamBodyAngleY = bounce * 2.2;
          targets.ParamBodyAngleZ = Math.sin(t * 1.8) * 2.4;
          targets.ParamShoulderLiftL = 0.2 * bounce;
          targets.ParamShoulderLiftR = 0.24 * bounce;
          targets.ParamChestExpand = 0.28;
          targets.ParamFloat = 0.12 + bounce * 0.07;
          if (showHeart) {
            armTarget = {
              abductDeg: 21 + Math.sin(t * 2.0) * 1.8,
              shoulderFlexDeg: 16,
              elbowFlexDeg: 147 + bounce * 3,
              planeYawDeg: 14,
              wristDeg: -4 + Math.sin(t * 2.2) * 4,
              hand: 'heart',
            };
          }
          break;
        }
        case 'worry': {
          // Tender, shy concern: gentle head droop + soft fist clutched near collarbone (distinct from high chin-rest think!)
          breathFreq = 0.33;
          smoothRate = 5.4;
          const holdConcern = t < 3.6;
          targets.ParamAngleX = Math.sin(t * 0.62) * 3.8;
          targets.ParamAngleY = -8.5 + Math.sin(t * 0.85) * 1.4;
          targets.ParamAngleZ = -6.8 + Math.sin(t * 0.48) * 1.6;
          targets.ParamBodyAngleY = -1.8;
          targets.ParamBodyAngleZ = -2.2 + Math.sin(t * 0.48) * 0.8;
          targets.ParamShoulderLiftL = 0.14;
          targets.ParamShoulderLiftR = 0.18;
          targets.ParamFloat = -0.08;
          if (holdConcern) {
            armTarget = {
              abductDeg: 9.5,
              shoulderFlexDeg: 18,
              elbowFlexDeg: 120 + Math.sin(t * 1.2) * 2.5,
              planeYawDeg: -34,
              wristDeg: 8 + Math.sin(t * 0.9) * 2.5,
              hand: 'chin',
            };
          }
          break;
        }
        case 'sleep': {
          breathFreq = 0.19;
          smoothRate = 3.8;
          const bWave = Math.sin(g * breathFreq * Math.PI * 2);
          targets.ParamAngleX = Math.sin(t * 0.28) * 2.2;
          targets.ParamAngleY = -11.5 + bWave * 1.8;
          targets.ParamAngleZ = 5.0 + Math.sin(t * 0.24) * 2.0;
          targets.ParamBodyAngleY = -2.2 + bWave * 0.8;
          targets.ParamBodyAngleZ = 1.5;
          targets.ParamChestExpand = 0.2 + bWave * 0.22;
          targets.ParamEyeBallX = 0;
          targets.ParamEyeBallY = -0.35;
          targets.ParamFloat = -0.1 + bWave * 0.06;
          targets.ParamWind = 0.12;
          armTarget = { ...ARM_POSE_REST };
          break;
        }
        case 'cheer': {
          // Energetic 2-phase encouragement: lively high-energy wave (0..1.9s) -> proud beaming finger-heart (1.9..4.3s) -> smooth rest
          smoothRate = 9.0;
          const activeBounce = t < 4.4;
          const hop = activeBounce ? Math.abs(Math.sin(t * 3.1)) : Math.abs(Math.sin(t * 1.2)) * 0.22;
          targets.ParamAngleX = Math.sin(t * 2.3) * 6.0;
          targets.ParamAngleY = 3.8 + hop * 4.2;
          targets.ParamAngleZ = Math.sin(t * 2.6) * 7.6;
          targets.ParamBodyAngleY = hop * 3.0;
          targets.ParamBodyAngleZ = Math.sin(t * 2.2) * 2.8;
          targets.ParamShoulderLiftL = 0.26 * hop;
          targets.ParamShoulderLiftR = 0.30 * hop;
          targets.ParamChestExpand = 0.32;
          targets.ParamFloat = 0.16 + hop * 0.11;
          if (t < 1.9) {
            armTarget = {
              abductDeg: 41,
              shoulderFlexDeg: 12,
              elbowFlexDeg: 138,
              planeYawDeg: 43,
              wristDeg: 0,
              hand: 'wave',
              forearmWaveDeg: 11,
              waveAmpDeg: 18,
              waveHz: 1.7,
            };
          } else if (t < 4.3) {
            armTarget = {
              abductDeg: 25,
              shoulderFlexDeg: 16,
              elbowFlexDeg: 147 + hop * 3,
              planeYawDeg: 20,
              wristDeg: -6 + Math.sin(t * 3.0) * 5,
              hand: 'heart',
            };
          }
          break;
        }
      }
    }

    // Smooth continuous pose parameters toward targets
    const alpha = clamp(1 - Math.exp(-smoothRate * dt), 0, 1);
    for (const [id, targetVal] of Object.entries(targets)) {
      this.cur[id] = lerp(this.cur[id] ?? 0, targetVal, alpha);
      core.setParameterValueById(id, this.cur[id]);
    }

    // Natural breath curve
    const breathVal = 0.5 + 0.5 * Math.sin(g * breathFreq * Math.PI * 2);
    core.setParameterValueById('ParamBreath', breathVal);

    // Keep legacy .moc3 arm parameters cleanly neutral (our 2-bone ArmRigRenderer replaces those 6 drawables)
    core.setParameterValueById('ParamArmRLift', 0);
    core.setParameterValueById('ParamArmRPose', 0);
    core.setParameterValueById('ParamHandRForm', 0);
    core.setParameterValueById('ParamHandRWave', 0);

    // Advance anatomical 2-bone arm controller
    this.armRig.setTarget(armTarget);
    this.armRig.step(dt);
  }

  /**
   * Called inside `internalModel.on('beforeModelUpdate')` right before `coreModel.update()`.
   * Handles natural irregular blinking & sleepy eyelids cleanly without clobbering expressions.
   */
  applyBeforeCommit(core: CoreParamSink | undefined, dtSec: number) {
    if (!core?.setParameterValueById || !core?.getParameterValueById) return;
    const dt = clamp(dtSec, 0, 0.08);

    core.setParameterValueById('ParamArmRLift', 0);
    core.setParameterValueById('ParamArmRPose', 0);
    core.setParameterValueById('ParamHandRForm', 0);
    core.setParameterValueById('ParamHandRWave', 0);

    if (this.state === 'sleep') {
      const cycle = this.stateElapsed % 7.5;
      const napOpen = cycle > 5.8 && cycle < 7.0 ? 0.26 * Math.sin(((cycle - 5.8) / 1.2) * Math.PI) : 0.04;
      core.setParameterValueById('ParamEyeLOpen', Math.min(core.getParameterValueById('ParamEyeLOpen'), napOpen));
      core.setParameterValueById('ParamEyeROpen', Math.min(core.getParameterValueById('ParamEyeROpen'), napOpen));
      return;
    }

    this.blinkTimer += dt;
    if (this.blinkTimer >= this.nextBlinkAt) {
      const bElapsed = this.blinkTimer - this.nextBlinkAt;
      const blinkDur = 0.15;
      if (bElapsed < blinkDur) {
        const closed = 1 - Math.sin((bElapsed / blinkDur) * Math.PI);
        core.setParameterValueById('ParamEyeLOpen', Math.min(core.getParameterValueById('ParamEyeLOpen'), closed));
        core.setParameterValueById('ParamEyeROpen', Math.min(core.getParameterValueById('ParamEyeROpen'), closed));
      } else {
        this.blinkTimer = 0;
        const seed = Math.abs(Math.sin(this.totalClock * 9.31) * 1000);
        const frac = seed - Math.floor(seed);
        if (!this.doubleBlinkPending && frac > 0.72) {
          this.doubleBlinkPending = true;
          this.nextBlinkAt = 0.22;
        } else {
          this.doubleBlinkPending = false;
          this.nextBlinkAt = 2.6 + frac * 2.8;
        }
      }
    }
  }
}
