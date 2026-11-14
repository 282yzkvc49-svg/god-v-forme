import { applyOps, emptyData, freshPlanOps, seedOps } from '../src/state/model';
import type { Op } from '../src/state/idb';
import type { AppData } from '../src/state/types';

export const NOW = '2026-10-25T15:00:00.000Z';

/**
 * Состояние «после первого запуска»: шаблоны, настройки и план питания со стартом 02.11.2026.
 * По умолчанию — базовый сценарий без командировок (движок плана); withTrips — как свежая установка в ноябре 2026.
 */
export function freshData(installDate = '2026-10-25', planStart: string | null = '2026-11-02', withTrips = false): AppData {
  let d = applyOps(emptyData(), seedOps(NOW, installDate));
  if (!withTrips) {
    d = applyOps(d, [
      ...Object.keys(d.trips).map((id) => ({ store: 'trips', del: id }) as Op),
      { store: 'settings', put: { ...d.settings, relaxOverrides: {}, training: { ...d.settings.training, startDate: '2026-11-02' } } },
    ]);
  }
  if (planStart) d = applyOps(d, freshPlanOps(d, planStart, installDate, NOW));
  d = applyOps(d, [{ store: 'settings', put: { ...d.settings, onboarded: true } }]);
  d.ready = true;
  return d;
}

export function apply(d: AppData, ops: Op[]): AppData {
  return applyOps(d, ops);
}
