// Регистрация service worker и баннер «Доступна новая версия».
let waiting: ServiceWorker | null = null;
const subs = new Set<() => void>();

export function onUpdateReady(cb: () => void): () => void {
  subs.add(cb);
  if (waiting) cb();
  return () => subs.delete(cb);
}

function announce(w: ServiceWorker) {
  waiting = w;
  subs.forEach((s) => s());
}

export function applyUpdate() {
  if (waiting) waiting.postMessage('skipWaiting');
  else location.reload();
}

export function registerSW() {
  if (!('serviceWorker' in navigator) || __DEV__ || (window as any).__SINGLE_FILE__) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return; // первая установка — перезагрузка не нужна
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) announce(nw);
      });
    });
    // проверять обновления при возвращении в приложение
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => { /* офлайн-режим просто не включится */ });
}
