import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, diffDays, fromParts, isISODate, isoWeekday, localDate, monthGrid, planMonthOf, range } from '../src/lib/dates';

test('календарные даты без сдвига часовых поясов', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // переход на летнее время в Европе
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(diffDays('2026-12-01', '2026-11-02'), 29);
  assert.equal(range('2026-11-02', '2026-12-01').length, 30);
});

test('localDate берёт местную дату, а не UTC', () => {
  // 23:30 по местному времени 1 ноября не должно стать 2 ноября
  const d = new Date(2026, 10, 1, 23, 30);
  assert.equal(localDate(d), '2026-11-01');
  const e = new Date(2026, 10, 2, 0, 15);
  assert.equal(localDate(e), '2026-11-02');
});

test('проверка формата и дни недели', () => {
  assert.ok(isISODate('2026-11-29'));
  assert.ok(!isISODate('2026-02-30'));
  assert.ok(!isISODate('29.11.2026'));
  assert.equal(isoWeekday('2026-11-02'), 1); // понедельник
  assert.equal(isoWeekday('2026-11-29'), 7); // воскресенье
  assert.equal(fromParts(2027, 1, 5), '2027-01-05');
});

test('месяцы и сетка календаря', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 14), '2028-01-15');
  const g = monthGrid('2026-11-10');
  assert.equal(g[0][0], '2026-10-26');
  assert.ok(g.flat().includes('2026-11-30'));
  assert.deepEqual(planMonthOf('2026-11-15', 2), { from: '2026-11-02', to: '2026-12-01' });
  assert.deepEqual(planMonthOf('2026-12-01', 2), { from: '2026-11-02', to: '2026-12-01' });
  assert.deepEqual(planMonthOf('2027-06-02', 2), { from: '2027-06-02', to: '2027-07-01' });
});
