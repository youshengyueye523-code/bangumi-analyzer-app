/**
 * 轻量桌面提示音效（纯 Web Audio API 合成，零外部音频请求，兼容严格 CSP）
 */
import { prefs } from './prefs';

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function tone(c: AudioContext, freq: number, start: number, dur: number, gainPeak = 0.032, type: OscillatorType = 'sine') {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export function playChime(kind: 'tap' | 'ok' | 'warn' | 'cheer') {
  if (!prefs.get().soundEnabled) return;
  try {
    const c = ctx();
    if (!c) return;
    const t = c.currentTime;
    if (kind === 'tap') {
      tone(c, 660, t, 0.07, 0.02, 'triangle');
    } else if (kind === 'ok') {
      tone(c, 587.33, t, 0.11, 0.028);
      tone(c, 880, t + 0.07, 0.16, 0.032);
    } else if (kind === 'warn') {
      tone(c, 440, t, 0.12, 0.03, 'triangle');
      tone(c, 349.23, t + 0.09, 0.18, 0.028, 'triangle');
    } else if (kind === 'cheer') {
      tone(c, 523.25, t, 0.1, 0.028);
      tone(c, 659.25, t + 0.07, 0.1, 0.028);
      tone(c, 783.99, t + 0.14, 0.12, 0.03);
      tone(c, 1046.5, t + 0.21, 0.22, 0.034);
    }
  } catch {
    /* ignore audio errors in headless */
  }
}
