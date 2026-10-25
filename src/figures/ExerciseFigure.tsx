import { useEffect, useMemo, useRef, useState } from 'react';
import { FIGURES, FLOOR, type Arrow, type FigureDef } from './poses';
import { blend, bounds, solve, solvedPoints, type Pose, type Pt, type Solved } from './skeleton';
import { EXERCISES } from '../lib/seed';
import { PiPause, PiPlay } from '../ui/icons';

const W_LIMB = 13;
const W_TORSO = 24;

function line(a: Pt, b: Pt, cls: string, w: number, key?: string) {
  return <line key={key} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={cls} strokeWidth={w} />;
}

function poly(pts: Pt[], cls: string, w: number, key?: string) {
  return <polyline key={key} points={pts.map((p) => p.join(',')).join(' ')} className={cls} strokeWidth={w} />;
}

function arrowPath(a: Arrow, i: number) {
  const p = a.pts;
  const d = p.length === 3 ? `M${p[0][0]},${p[0][1]} Q${p[1][0]},${p[1][1]} ${p[2][0]},${p[2][1]}` : `M${p[0][0]},${p[0][1]} L${p[1][0]},${p[1][1]}`;
  const end = p[p.length - 1], prev = p[p.length - 2];
  const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
  const s = 11;
  const head: Pt[] = [
    [end[0] + Math.cos(ang) * 4, end[1] + Math.sin(ang) * 4],
    [end[0] + Math.cos(ang + 2.5) * s, end[1] + Math.sin(ang + 2.5) * s],
    [end[0] + Math.cos(ang - 2.5) * s, end[1] + Math.sin(ang - 2.5) * s],
  ];
  return (
    <g key={`a${i}`}>
      <path d={d} className="arrow" />
      <polygon points={head.map((q) => q.join(',')).join(' ')} className="arrow-head" />
    </g>
  );
}

function kettlebell(c: Pt, rot = 0) {
  const [x, y] = c;
  return (
    <g key="bell" transform={rot ? `rotate(${rot} ${x} ${y})` : undefined}>
      <path d={`M${x - 9},${y - 10} C${x - 12},${y - 31} ${x + 12},${y - 31} ${x + 9},${y - 10}`} className="bell-handle" strokeWidth={5} />
      <circle cx={x} cy={y} r={15} className="bell" />
      <rect x={x - 9} y={y + 11} width={18} height={5} rx={2} className="bell" />
    </g>
  );
}

function limb(s: Solved, i: 0 | 1, part: 'leg' | 'arm', cls: string) {
  if (part === 'leg') {
    return (
      <g key={`leg${i}`}>
        {poly([s.hip, s.knees[i], s.ankles[i]], cls, W_LIMB)}
        {poly([s.heels[i], s.ankles[i], s.toes[i]], cls, 9)}
      </g>
    );
  }
  return (
    <g key={`arm${i}`}>
      {poly([s.shoulder, s.elbows[i], s.wrists[i]], cls, i === 0 ? 11.5 : 11)}
      <circle cx={s.wrists[i][0]} cy={s.wrists[i][1]} r={6.5} className={i === 0 ? 'head' : 'head far-fill'} style={i === 1 ? { fill: 'color-mix(in srgb, var(--ink) 38%, var(--surface))' } : undefined} />
    </g>
  );
}

function stepperProp(pedals: [number, number]) {
  const pivot: Pt = [150, 240];
  const frontX = 258;
  const yAt = (front: number, x: number) => pivot[1] + ((front - pivot[1]) * (x - pivot[0])) / (frontX - pivot[0]);
  return (
    <g key="stepper">
      <line x1={pivot[0]} y1={pivot[1]} x2={frontX} y2={pedals[1]} className="limb far" strokeWidth={8} style={{ stroke: 'color-mix(in srgb, var(--ink-3) 55%, var(--surface))' }} />
      <rect x={136} y={248} width={134} height={12} rx={5} className="gear" />
      <line x1={238} y1={250} x2={238} y2={yAt(pedals[0], 238)} className="limb" strokeWidth={5} style={{ stroke: 'var(--ink-3)' }} />
      <line x1={pivot[0]} y1={pivot[1]} x2={frontX} y2={pedals[0]} className="limb" strokeWidth={9} style={{ stroke: 'var(--ink-3)' }} />
      <circle cx={pivot[0]} cy={pivot[1]} r={6} className="gear-dark" />
    </g>
  );
}

export function FigureSVG({ def, pose, pedals, frameIndex, viewBox, title, marks = true }: {
  def: FigureDef; pose: Pose; pedals?: [number, number]; frameIndex: 0 | 1 | null; viewBox: string; title: string; marks?: boolean;
}) {
  const s = solve(pose);
  const arrows = marks && frameIndex != null ? def.arrows?.[frameIndex] ?? [] : [];
  const guides = marks && frameIndex != null ? def.guides?.[frameIndex] ?? [] : [];
  const [vx, , vw] = viewBox.split(' ').map(Number);
  return (
    <svg className="fig-svg" viewBox={viewBox} role="img" aria-label={title}>
      <line x1={vx + 6} y1={FLOOR + 1} x2={vx + vw - 6} y2={FLOOR + 1} className="floor" />
      {def.props === 'mat' && <rect x={60} y={FLOOR - 6} width={272} height={6} rx={3} className="mat" />}
      {def.props === 'stepper' && pedals && stepperProp(pedals)}
      {limb(s, 1, 'arm', 'limb far')}
      {limb(s, 1, 'leg', 'limb far')}
      {line(s.hip, s.shoulder, 'torso', W_TORSO)}
      {line(s.shoulder, s.head, 'torso', 9)}
      <circle cx={s.head[0]} cy={s.head[1]} r={15} className="head" />
      {limb(s, 0, 'leg', 'limb')}
      {s.bell && kettlebell(s.bell, s.bellRot)}
      {limb(s, 0, 'arm', 'limb')}
      {guides.map((g, i) => <polyline key={`g${i}`} points={g.pts.map((p) => p.join(',')).join(' ')} className="guide" />)}
      {arrows.map(arrowPath)}
    </svg>
  );
}

export function computeViewBoxForPreview(def: FigureDef): string {
  return computeViewBox(def);
}

function computeViewBox(def: FigureDef): string {
  const pts: Pt[] = [];
  for (const f of def.frames) pts.push(...solvedPoints(solve(f)));
  for (const fr of [...(def.arrows ?? []), ...(def.guides ?? [])]) for (const a of fr) pts.push(...a.pts);
  if (def.props === 'mat') pts.push([60, FLOOR], [332, FLOOR]);
  if (def.props === 'stepper') pts.push([136, FLOOR], [270, 210]);
  pts.push([0, FLOOR + 6]);
  const b = bounds(pts.filter((p) => p[0] !== 0));
  const pad = 14;
  let x0 = b.x0 - pad, x1 = b.x1 + pad, y0 = b.y0 - pad;
  const y1 = FLOOR + 10;
  let w = x1 - x0, h = y1 - y0;
  // соотношение 4:3, пол всегда внизу
  if (w / h > 4 / 3) { const nh = (w * 3) / 4; y0 = y1 - nh; h = nh; }
  else { const nw = (h * 4) / 3; const cx = (x0 + x1) / 2; x0 = cx - nw / 2; x1 = cx + nw / 2; w = nw; }
  return `${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
}

function usePrefersReducedMotion() {
  return useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);
}

/** Два кадра техники (исходное и ключевое положение) и, по желанию, плавная анимация между ними. */
export function ExerciseFigure({ exerciseId, compact }: { exerciseId: string; compact?: boolean }) {
  const ex = EXERCISES[exerciseId];
  const def = FIGURES[ex?.figure ?? exerciseId];
  const reduced = usePrefersReducedMotion();
  const [anim, setAnim] = useState(false);
  const vb = useMemo(() => (def ? computeViewBox(def) : '0 0 400 300'), [def]);
  if (!ex || !def) return null;
  return (
    <div className="figure-box">
      {anim ? (
        <div className="figure-frames single">
          <figure className="figure-frame" style={{ margin: 0 }}>
            <AnimatedFigure def={def} viewBox={vb} title={`${ex.name}: движение`} />
            <figcaption>Движение: {ex.frames[0].replace(/^Исходное:\s*/i, '')} → {ex.frames[1].replace(/^Ключевое:\s*/i, '')}</figcaption>
          </figure>
        </div>
      ) : (
        <div className="figure-frames">
          {[0, 1].map((i) => (
            <figure key={i} className="figure-frame" style={{ margin: 0 }}>
              <FigureSVG def={def} pose={def.frames[i]} pedals={def.pedals?.[i]} frameIndex={i as 0 | 1} viewBox={vb} title={`${ex.name}, кадр ${i + 1}: ${ex.frames[i]}`} />
              {!compact && <figcaption><b>{i + 1}</b>{ex.frames[i]}</figcaption>}
            </figure>
          ))}
        </div>
      )}
      {!compact && (
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn small" onClick={() => setAnim(!anim)} aria-pressed={anim}>
            {anim ? <><PiPause /> Показать два кадра</> : <><PiPlay /> Анимация движения</>}
          </button>
          {reduced && anim && <span className="hint">В системе включено «Уменьшение движения» — анимация замедлена.</span>}
        </div>
      )}
    </div>
  );
}

function AnimatedFigure({ def, viewBox, title }: { def: FigureDef; viewBox: string; title: string }) {
  const [k, setK] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const period = reduced ? 6000 : 3200;
    const start = performance.now();
    const tick = (now: number) => {
      const t = ((now - start) % period) / period; // 0..1
      // туда (0–0.4), пауза (0.4–0.5), обратно (0.5–0.9), пауза
      let x = t < 0.4 ? t / 0.4 : t < 0.5 ? 1 : t < 0.9 ? 1 - (t - 0.5) / 0.4 : 0;
      x = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
      setK(x);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);
  const pose = blend(def.frames[0], def.frames[1], k);
  const pedals: [number, number] | undefined = def.pedals
    ? [def.pedals[0][0] + (def.pedals[1][0] - def.pedals[0][0]) * k, def.pedals[0][1] + (def.pedals[1][1] - def.pedals[0][1]) * k]
    : undefined;
  return <FigureSVG def={def} pose={pose} pedals={pedals} frameIndex={null} viewBox={viewBox} title={title} />;
}

/** Маленькая статичная миниатюра (ключевой кадр) для списков. */
export function ExerciseThumb({ exerciseId }: { exerciseId: string }) {
  const ex = EXERCISES[exerciseId];
  const def = FIGURES[ex?.figure ?? exerciseId];
  const vb = useMemo(() => (def ? computeViewBox(def) : '0 0 400 300'), [def]);
  if (!def) return null;
  return <FigureSVG def={def} pose={def.frames[1]} pedals={def.pedals?.[1]} frameIndex={null} viewBox={vb} title={ex.name} marks={false} />;
}
