// Видимая область экрана на iPad/iPhone.
//
// В установленном приложении Safari после экранной клавиатуры видимая область может остаться сдвинутой
// относительно «layout viewport» (по нему считаются position: fixed и sticky): нижняя панель оказывается посреди
// экрана, боковая панель уезжает вверх, липкая правая колонка обрезается по середине экрана.
// Здесь:
//  1) --vv-bottom — нижний край реально видимой области (по нему стоит таймер отдыха на iPad);
//  2) «клавиатура открыта» — только если поле ввода в фокусе И видимая область заметно уменьшилась
//     (аппаратная клавиатура или поле, оставшееся в фокусе после закрытия клавиатуры, таймер не прячут);
//  3) после закрытия клавиатуры — поле теряет фокус, и если видимая область осталась сдвинутой,
//     прокрутка на 1 px и обратно заставляет Safari пересчитать её.
import { useSyncExternalStore } from 'react';

const KB_MIN = 120;
let baseline = 0;
let baseWidth = 0;
let kbOpen = false;
let lastBottom = '';
const subs = new Set<() => void>();

function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/.test((el as HTMLInputElement).type);
}

export interface ViewportInfo {
  innerW: number; innerH: number; vvW: number | null; vvH: number | null; vvTop: number | null; vvScale: number | null;
  screenW: number; screenH: number; standalone: boolean; coarse: boolean; keyboard: boolean; baseline: number; dvh: number; vh: number; scrollY: number;
}

export function viewportInfo(): ViewportInfo {
  const vv = window.visualViewport;
  const probe = (u: string) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;visibility:hidden;height:100${u};width:1px;top:0;left:0`;
    document.body.appendChild(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return Math.round(h);
  };
  return {
    innerW: window.innerWidth, innerH: window.innerHeight,
    vvW: vv ? Math.round(vv.width) : null, vvH: vv ? Math.round(vv.height) : null, vvTop: vv ? Math.round(vv.offsetTop) : null, vvScale: vv ? Math.round(vv.scale * 100) / 100 : null,
    screenW: screen.width, screenH: screen.height,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true,
    coarse: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    keyboard: kbOpen, baseline: Math.round(baseline), dvh: probe('dvh'), vh: probe('vh'), scrollY: Math.round(window.scrollY),
  };
}

/** Выровнять видимую область, если она осталась сдвинутой (после клавиатуры). */
export function repairViewport(force = false) {
  const vv = window.visualViewport;
  if (!vv || vv.scale > 1.02 || editableFocused()) return;
  if (!force && Math.abs(vv.offsetTop) < 1) return;
  const x = window.scrollX, y = window.scrollY;
  window.scrollTo(x, y + 1);
  window.scrollTo(x, y);
}

function update() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;
  if (Math.abs(window.innerWidth - baseWidth) > 40) { baseWidth = window.innerWidth; baseline = 0; }
  const typing = editableFocused();
  if (!typing && vv.scale < 1.02) baseline = Math.max(baseline, vv.height);
  const open = typing && baseline > 0 && vv.height < baseline - KB_MIN;
  const bottom = `${Math.round(vv.offsetTop + vv.height)}px`;
  if (bottom !== lastBottom) { root.style.setProperty('--vv-bottom', bottom); lastBottom = bottom; }
  if (open !== kbOpen) {
    kbOpen = open;
    if (open) root.setAttribute('data-kb', '');
    else root.removeAttribute('data-kb');
    subs.forEach((s) => s());
  }
}

let installed = false;
export function installViewportWatch() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const vv = window.visualViewport;
  baseWidth = window.innerWidth;
  let lastH = vv?.height ?? 0;
  const onResize = () => {
    const h = vv?.height ?? 0;
    // клавиатура закрылась (видимая область выросла), а поле осталось в фокусе — снять фокус
    if (vv && h - lastH > KB_MIN && vv.scale < 1.02 && editableFocused()) (document.activeElement as HTMLElement).blur();
    lastH = h;
    update();
    if (!editableFocused()) setTimeout(() => repairViewport(), 250);
  };
  vv?.addEventListener('resize', onResize);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  // поворот экрана: высота отсчёта сбрасывается в update(), если изменилась ширина окна
  window.addEventListener('orientationchange', () => setTimeout(update, 300));
  document.addEventListener('focusin', () => setTimeout(update, 60));
  document.addEventListener('focusout', () => setTimeout(() => { update(); repairViewport(); }, 300));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => { update(); repairViewport(); }, 300); });
  update();
}

/** Экранная клавиатура открыта (поле ввода в фокусе и видимая область уменьшилась). */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => kbOpen, () => false);
}
