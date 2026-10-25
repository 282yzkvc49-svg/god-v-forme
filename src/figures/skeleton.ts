// Двумерная модель тела в профиль: постоянные длины сегментов, суставы через обратную кинематику (2 звена).
// Благодаря постоянным длинам кадры и анимация сохраняют правильные пропорции.

export type Pt = [number, number];

export const L = {
  torso: 78,
  neck: 10,
  headR: 15,
  upperArm: 46,
  forearm: 42,
  thigh: 62,
  shin: 58,
  foot: 21,
  heel: 7,
};

export interface LimbSpec {
  target: Pt; // запястье или голеностоп
  hint: Pt; // направление сгиба локтя/колена
}

export interface Pose {
  hip: Pt;
  torso: number; // угол «таз → плечи», градусы в координатах SVG (−90 — вертикально вверх)
  head?: Pt | null; // явное положение головы (если шея согнута)
  legs: [LimbSpec, LimbSpec]; // ближняя, дальняя
  feet: [number, number]; // угол стопы (0 — носок вперёд по полу), градусы, по часовой
  arms: [LimbSpec, LimbSpec];
  bell?: { at: Pt } | null; // центр шара гири
  bellRot?: number; // поворот гири (дужка смотрит к кисти), градусы
}

export interface Solved {
  hip: Pt;
  shoulder: Pt;
  head: Pt;
  knees: [Pt, Pt];
  ankles: [Pt, Pt];
  toes: [Pt, Pt];
  heels: [Pt, Pt];
  elbows: [Pt, Pt];
  wrists: [Pt, Pt];
  bell: Pt | null;
  bellRot: number;
}

const rad = (d: number) => (d * Math.PI) / 180;
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const dir = (deg: number): Pt => [Math.cos(rad(deg)), Math.sin(rad(deg))];

/** Средний сустав двухзвенной цепи. Цель вне досягаемости — конечность выпрямляется к ней. */
export function ik(root: Pt, target: Pt, l1: number, l2: number, hint: Pt): { mid: Pt; end: Pt } {
  const v = sub(target, root);
  let d = len(v);
  const maxD = l1 + l2 - 0.001, minD = Math.abs(l1 - l2) + 0.001;
  const u: Pt = d > 1e-6 ? mul(v, 1 / d) : [0, 1];
  d = Math.max(minD, Math.min(maxD, d));
  const end = add(root, mul(u, d));
  const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const base = Math.atan2(u[1], u[0]);
  const c1: Pt = add(root, [Math.cos(base + a) * l1, Math.sin(base + a) * l1]);
  const c2: Pt = add(root, [Math.cos(base - a) * l1, Math.sin(base - a) * l1]);
  const s1 = (c1[0] - root[0]) * hint[0] + (c1[1] - root[1]) * hint[1];
  const s2 = (c2[0] - root[0]) * hint[0] + (c2[1] - root[1]) * hint[1];
  return { mid: s1 >= s2 ? c1 : c2, end };
}

export function solve(p: Pose): Solved {
  const t = dir(p.torso);
  const shoulder = add(p.hip, mul(t, L.torso));
  const head = p.head ?? add(shoulder, mul(t, L.neck + L.headR));
  const legs = p.legs.map((lg) => ik(p.hip, lg.target, L.thigh, L.shin, lg.hint));
  const arms = p.arms.map((ar) => ik(shoulder, ar.target, L.upperArm, L.forearm, ar.hint));
  const ankles = legs.map((l) => l.end) as [Pt, Pt];
  const toes = ankles.map((a, i) => add(a, mul(dir(p.feet[i] + 17), L.foot))) as [Pt, Pt];
  const heels = ankles.map((a, i) => add(a, mul(dir(p.feet[i] + 135), L.heel))) as [Pt, Pt];
  return {
    hip: p.hip, shoulder, head,
    knees: legs.map((l) => l.mid) as [Pt, Pt],
    ankles, toes, heels,
    elbows: arms.map((a) => a.mid) as [Pt, Pt],
    wrists: arms.map((a) => a.end) as [Pt, Pt],
    bell: p.bell?.at ?? null,
    bellRot: p.bellRot ?? 0,
  };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpPt = (a: Pt, b: Pt, k: number): Pt => [lerp(a[0], b[0], k), lerp(a[1], b[1], k)];

/** Промежуточная поза для анимации: интерполируем параметры, суставы считаются заново. */
export function blend(a: Pose, b: Pose, k: number): Pose {
  return {
    hip: lerpPt(a.hip, b.hip, k),
    torso: lerp(a.torso, b.torso, k),
    head: a.head && b.head ? lerpPt(a.head, b.head, k) : a.head || b.head ? lerpPt(a.head ?? solve(a).head, b.head ?? solve(b).head, k) : null,
    legs: [0, 1].map((i) => ({ target: lerpPt(a.legs[i].target, b.legs[i].target, k), hint: k < 0.5 ? a.legs[i].hint : b.legs[i].hint })) as [LimbSpec, LimbSpec],
    feet: [lerp(a.feet[0], b.feet[0], k), lerp(a.feet[1], b.feet[1], k)],
    arms: [0, 1].map((i) => ({ target: lerpPt(a.arms[i].target, b.arms[i].target, k), hint: k < 0.5 ? a.arms[i].hint : b.arms[i].hint })) as [LimbSpec, LimbSpec],
    bell: a.bell && b.bell ? { at: lerpPt(a.bell.at, b.bell.at, k) } : null,
    bellRot: a.bellRot,
  };
}

export function bounds(points: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

export function solvedPoints(s: Solved): Pt[] {
  const pts: Pt[] = [s.hip, s.shoulder, ...s.knees, ...s.ankles, ...s.toes, ...s.heels, ...s.elbows, ...s.wrists];
  pts.push([s.head[0] - L.headR, s.head[1] - L.headR], [s.head[0] + L.headR, s.head[1] + L.headR]);
  if (s.bell) pts.push([s.bell[0] - 18, s.bell[1] - 26], [s.bell[0] + 18, s.bell[1] + 18]);
  return pts;
}
