// Маршрутизация через hash (#/today) — работает на GitHub Pages в подпапке и офлайн.
import { useSyncExternalStore } from 'react';

export interface Route { path: string[]; query: URLSearchParams; raw: string }

function parse(): Route {
  const raw = location.hash.replace(/^#/, '') || '/today';
  const [p, q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q), raw };
}

let current = parse();
let depth = 0; // сколько переходов внутри приложения можно «отмотать» кнопкой «Назад»
let goingBack = false;
const subs = new Set<() => void>();

function notify() {
  current = parse();
  for (const s of subs) s();
}

window.addEventListener('hashchange', () => {
  if (goingBack) goingBack = false;
  else depth++;
  notify();
  window.scrollTo(0, 0);
});

export function useRoute(): Route {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current, () => current);
}

export function href(path: string, query?: Record<string, string | number | null | undefined>): string {
  const q = query ? Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return `#${path}${q ? `?${q}` : ''}`;
}

export function go(path: string, query?: Record<string, string | number | null | undefined>, replace = false) {
  const h = href(path, query);
  if (replace) {
    history.replaceState(history.state, '', h);
    notify();
  } else location.hash = h.slice(1);
}

/** «Назад»: внутри приложения — по истории, иначе — на родительский экран. */
export function back(fallback = '/today') {
  if (depth > 0) {
    depth--;
    goingBack = true;
    history.back();
  } else go(fallback, undefined, true);
}
