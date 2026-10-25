import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PiCaretLeft, PiCheckBold, PiInfo, PiMinus, PiPlus, PiWarning, PiX } from './icons';
import { back } from '../app/router';
import { parseNum, fmtNum } from '../lib/util';

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); };
  }, [query]);
  return m;
}

// ------------------------------------------------------------------ всплывающее окно

export function Sheet({ open, onClose, title, children, wide, label }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    setTimeout(() => ref.current?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label || (typeof title === 'string' ? title : undefined)} tabIndex={-1} ref={ref}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><PiX /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ уведомления

interface ToastItem { id: number; text: string; action?: { label: string; run: () => void } }
let toasts: ToastItem[] = [];
const toastSubs = new Set<() => void>();
let toastSeq = 0;
export function toast(text: string, action?: ToastItem['action'], ms = 3200) {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-1), { id, text, action }];
  toastSubs.forEach((s) => s());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastSubs.forEach((s) => s());
  }, ms);
}
export function Toasts() {
  const list = useSyncExternalStore((cb) => { toastSubs.add(cb); return () => toastSubs.delete(cb); }, () => toasts, () => toasts);
  if (!list.length) return null;
  const t = list[list.length - 1];
  return (
    <div className="toast-wrap" aria-live="polite">
      <div className="toast" key={t.id}>
        <span>{t.text}</span>
        {t.action && <button onClick={() => { t.action!.run(); toasts = []; toastSubs.forEach((s) => s()); }}>{t.action.label}</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ элементы управления

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <span className="grow">
        <span style={{ display: 'block', fontWeight: 550 }}>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
    </label>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, full, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; full?: boolean; label?: string }) {
  return (
    <div className={`seg${full ? ' full' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export type CheckState = 'on' | 'off' | 'skip' | 'idle';
export function CheckButton({ state, onClick, label, small }: { state: CheckState; onClick: () => void; label: string; small?: boolean }) {
  return (
    <button type="button" className={`check ${state === 'on' ? 'on' : state === 'skip' ? 'skip' : state === 'idle' ? 'idle' : ''}${small ? ' small' : ''}`} aria-pressed={state === 'on'} aria-label={label} onClick={onClick}>
      {state === 'on' ? <PiCheckBold /> : state === 'skip' ? <PiMinus /> : null}
    </button>
  );
}

export function Note({ kind = 'info', children, icon }: { kind?: 'info' | 'warn' | 'danger' | 'ok' | 'rose' | 'plain'; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={`note ${kind === 'plain' ? '' : kind}`}>
      {icon ?? (kind === 'warn' || kind === 'danger' ? <PiWarning /> : <PiInfo />)}
      <div className="grow">{children}</div>
    </div>
  );
}

export function Empty({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="btn-row">{actions}</div>}
    </div>
  );
}

export function PageHead({ title, sub, backTo, right }: { title: ReactNode; sub?: ReactNode; backTo?: string; right?: ReactNode }) {
  return (
    <>
      {backTo && (
        <button className="back no-print" onClick={() => back(backTo)}><PiCaretLeft /> Назад</button>
      )}
      <div className="page-head">
        <div className="grow">
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {right && <div className="row no-print">{right}</div>}
      </div>
    </>
  );
}

/** Поле числа с кнопками ±. Запятая и точка допустимы. */
export function NumberStepper({ value, onChange, step = 1, min = 0, max = 999, unit, label, width }: {
  value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; unit?: string; label: string; width?: number;
}) {
  const [text, setText] = useState(value == null ? '' : fmtNum(value, 2));
  useEffect(() => { setText(value == null ? '' : fmtNum(value, 2)); }, [value]);
  const commitText = (t: string) => {
    const n = parseNum(t);
    if (n == null) { onChange(null); return; }
    onChange(Math.min(max, Math.max(min, n)));
  };
  const bump = (d: number) => {
    const base = value ?? (d > 0 ? min : min);
    const n = Math.round((base + d) * 100) / 100;
    onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <div className="stepper-input">
      <button type="button" className="icon-btn" style={{ background: 'var(--surface-3)' }} onClick={() => bump(-step)} aria-label={`${label}: меньше`}><PiMinus /></button>
      <input
        className="input" inputMode="decimal" enterKeyHint="done" autoComplete="off" aria-label={label} style={width ? { width } : undefined}
        value={text} placeholder="—" onChange={(e) => setText(e.target.value)} onBlur={(e) => commitText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <button type="button" className="icon-btn" style={{ background: 'var(--surface-3)' }} onClick={() => bump(step)} aria-label={`${label}: больше`}><PiPlus /></button>
      {unit && <span className="muted">{unit}</span>}
    </div>
  );
}

/** Кольцо прогресса дня. */
export function Ring({ done, total, size = 76 }: { done: number; total: number; size?: number }) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Выполнено ${done} из ${total}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth="8" />
      {frac > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .4s ease' }} />}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.24}>{done}/{total}</text>
    </svg>
  );
}

/** Скрыть/показать блок. */
export function Disclosure({ summary, children, defaultOpen }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button type="button" className="btn ghost small" style={{ paddingLeft: 0 }} aria-expanded={open} onClick={() => setOpen(!open)}>
        {summary} {open ? '▴' : '▾'}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}
