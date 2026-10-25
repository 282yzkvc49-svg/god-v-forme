// «Сегодня» по часам устройства (календарная дата, не UTC). Обновляется при возвращении в приложение
// и раз в минуту — после полуночи экран «Сегодня» сам переключится на новый день.
import { useEffect, useState } from 'react';
import { isISODate, localDate, type ISODate } from './dates';

const OVERRIDE_KEY = 'gvf:today-override';

/** Для проверки сценариев: ?today=2026-11-02 в адресе (хранится только в этой вкладке). */
function readOverride(): ISODate | null {
  try {
    const m = /[?&]today=(\d{4}-\d{2}-\d{2})/.exec(location.search) || /[?&]today=(\d{4}-\d{2}-\d{2})/.exec(location.hash);
    if (m && isISODate(m[1])) sessionStorage.setItem(OVERRIDE_KEY, m[1]);
    if (/[?&]today=off/.test(location.search)) sessionStorage.removeItem(OVERRIDE_KEY);
    const v = sessionStorage.getItem(OVERRIDE_KEY);
    return v && isISODate(v) ? v : null;
  } catch {
    return null;
  }
}

const override = typeof window !== 'undefined' ? readOverride() : null;

export function today(): ISODate {
  return override ?? localDate();
}

export function isTodayOverridden(): boolean {
  return !!override;
}

export function useToday(): ISODate {
  const [t, setT] = useState(today());
  useEffect(() => {
    const tick = () => setT(today());
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return t;
}
