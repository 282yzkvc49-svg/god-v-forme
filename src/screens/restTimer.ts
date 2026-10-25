// Таймер отдыха: состояние вне React, чтобы не сбрасывалось при переходе к технике упражнения.
// Время считается по отметке окончания (endAt), поэтому таймер верен и после блокировки экрана.
import { useSyncExternalStore } from 'react';

export type TimerMode = 'rest' | 'hold';
export interface TimerState {
  status: 'idle' | 'running' | 'paused' | 'finished';
  mode: TimerMode;
  duration: number; // мс
  endAt: number; // для running
  remaining: number; // для paused
  label: string;
}

let state: TimerState = { status: 'idle', mode: 'rest', duration: 75_000, endAt: 0, remaining: 75_000, label: 'Отдых' };
const subs = new Set<() => void>();
let tickId: ReturnType<typeof setInterval> | null = null;
let onFinish: (() => void) | null = null;
let audio: AudioContext | null = null;
let soundOn = true;

function emit() { subs.forEach((s) => s()); }
function set(p: Partial<TimerState>) { state = { ...state, ...p }; emit(); }

export function setSound(on: boolean) { soundOn = on; }

/** Разблокировать звук (iOS разрешает только после касания). */
export function unlockAudio() {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    if (!audio) audio = new AC();
    if (audio!.state === 'suspended') audio!.resume();
  } catch { /* без звука */ }
}

function beep() {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* нет вибрации */ }
  if (!soundOn || !audio) return;
  try {
    const t0 = audio.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = i === 2 ? 990 : 740;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.28);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.28 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.28 + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(t0 + i * 0.28);
      o.stop(t0 + i * 0.28 + 0.24);
    }
  } catch { /* без звука */ }
}

function ensureTick() {
  if (tickId) return;
  tickId = setInterval(() => {
    if (state.status !== 'running') return;
    if (Date.now() >= state.endAt) {
      set({ status: 'finished', remaining: 0 });
      beep();
      const cb = onFinish;
      onFinish = null;
      cb?.();
    } else set({}); // новый объект — React перерисует оставшееся время
  }, 250);
}

export function startTimer(ms: number, mode: TimerMode = 'rest', label = 'Отдых', cb: (() => void) | null = null) {
  unlockAudio();
  onFinish = cb;
  set({ status: 'running', mode, duration: ms, endAt: Date.now() + ms, remaining: ms, label });
  ensureTick();
}

export function pauseTimer() {
  if (state.status !== 'running') return;
  set({ status: 'paused', remaining: Math.max(0, state.endAt - Date.now()) });
}

export function resumeTimer() {
  if (state.status !== 'paused') return;
  set({ status: 'running', endAt: Date.now() + state.remaining });
  ensureTick();
}

export function stopTimer() {
  onFinish = null;
  set({ status: 'idle', remaining: state.duration });
}

export function setDuration(ms: number) {
  if (state.status === 'running') set({ duration: ms, endAt: Date.now() + ms });
  else set({ duration: ms, remaining: ms, status: state.status === 'finished' ? 'idle' : state.status });
}

export function remainingMs(s: TimerState = state): number {
  if (s.status === 'running') return Math.max(0, s.endAt - Date.now());
  if (s.status === 'paused') return s.remaining;
  if (s.status === 'finished') return 0;
  return s.duration;
}

export function useTimer(): TimerState {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => state, () => state);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') set({}); });
}
