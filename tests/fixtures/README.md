# Тестовые данные

`state_1.2.0.json` — база устройства, на котором после версии 1.2.0 новое меню не применили. Состав: первый план со стартом 02.11, перенос старта на 16.11 в версии 1.2.0 (миграция v5), две отметки пользователя («съедено» 03.11 и 10.11). В плане со стартом 16.11 скумбрия стоит 28.11, 30.11, 07.12, 08.12 и 09.12, готовки — 28.11 и 07.12, закупки — 15.11 и 01.12. Эти же даты были в экспорте отчёта `report_2026-11.zip`.

Как получен файл: сборка по коммиту `fde8436` (версия 1.2.0) в отдельной рабочей копии.

```sh
git worktree add /tmp/wt120 fde8436 && ln -s "$PWD/node_modules" /tmp/wt120/node_modules
cd /tmp/wt120 && cat > dump.ts <<'EOF'
import { emptyData, applyOps, planV5Ops, seedOps, freshPlanOps } from './src/state/model';
import { writeFileSync } from 'node:fs';
let d = emptyData();
d = applyOps(d, seedOps('2026-10-25T10:00:00Z', '2026-10-25'));
d = applyOps(d, [{ store: 'settings', put: { ...d.settings, onboarded: true } }]);
d = applyOps(d, freshPlanOps(d, '2026-11-02', '2026-10-26', '2026-10-26T10:00:00Z'));
const mk = (taskId: string, date: string) => ({ store: 'taskStatus', put: { taskId, date, status: 'done', updatedAt: '2026-11-10T10:00:00Z' } });
d = applyOps(d, [mk('meal:2026-11-10:lunch', '2026-11-10'), mk('meal:2026-11-03:breakfast', '2026-11-03')] as any);
d = applyOps(d, planV5Ops(d, '2026-11-14', '2026-11-14T12:00:00Z'));
const out: any = {};
for (const k of Object.keys(d)) if (k !== 'ready') out[k] = (d as any)[k];
writeFileSync(process.argv[2], JSON.stringify(out));
EOF
npx tsx dump.ts state_1.2.0.json
```

`state_1.6.0_2211.json` — база устройства на 22.11 (версия 1.6.0): меню v2 со старта 16.11, Санкт-Петербург уже перенесена на 25–26.11 (миграция v8 20.11), первая закупка отмечена, завтрак 22.11 отмечен «съедено». Получена из `freshData` (tests/helpers.ts) с прежними датами командировки (24–25.11), полным пересчётом 14.11, `dataMigrationOps` 20.11 и отметкой завтрака; `settings.tripReportUnseen` очищен (отчёт о переносе уже просмотрен).
