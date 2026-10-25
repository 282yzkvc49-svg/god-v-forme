import { applyOps, emptyData, seedOps } from '../src/state/model';
import type { Op } from '../src/state/idb';
import type { AppData } from '../src/state/types';

export const NOW = '2026-10-25T15:00:00.000Z';

/** Состояние «после первого запуска» с seed. */
export function freshData(installDate = '2026-10-25'): AppData {
  const d = applyOps(emptyData(), seedOps(NOW, installDate));
  d.ready = true;
  return d;
}

export function apply(d: AppData, ops: Op[]): AppData {
  return applyOps(d, ops);
}
