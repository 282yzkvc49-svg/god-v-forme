import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { apply, freshData, NOW } from './helpers';
import { buildReport } from '../src/domain/report';
import { buildBackupZip, buildReportZip, decryptBytes, encryptBytes, isEncrypted, readBackup, restoreOps } from '../src/domain/zipfiles';
import { STORE_KEYS, type PhotoMeta } from '../src/state/types';
import { applyOps, emptyData } from '../src/state/model';
import { templateFor } from '../src/domain/templates';

const opts = (over: any = {}) => ({
  from: '2026-11-02', to: '2026-12-01', today: '2026-12-02', photos: [] as PhotoMeta[], notes: '',
  include: { weights: true, workouts: true, nutrition: true, notes: true }, appVersion: 'test', generatedAt: NOW, ...over,
});

function withData() {
  let d = freshData();
  const t = templateFor(d, 'strength_a', '2026-11-02')!;
  d = apply(d, [
    { store: 'weights', put: { id: 'w1', date: '2026-11-02', kg: 106.4, createdAt: NOW } },
    { store: 'weights', put: { id: 'w2', date: '2026-11-30', kg: 103.9, createdAt: NOW } },
    { store: 'trainingLogs', put: {
      id: 'train:2026-11-02', plannedDate: '2026-11-02', date: '2026-11-02', templateId: 'strength_a', templateVersionId: 'strength_a@seed', templateSnapshot: t,
      status: 'done', feeling: 'ok', note: 'присед легко',
      exercises: t.items.map((it, index) => ({ index, exerciseId: it.exerciseId, sets: Array.from({ length: it.sets }, (_, i) => i === 0), weightKg: it.exerciseId === 'goblet_squat' ? 12 : null, difficulty: it.exerciseId === 'goblet_squat' ? 'easy' : null })),
      updatedAt: NOW,
    } },
    { store: 'taskStatus', put: { taskId: 'meal:2026-11-02:lunch', date: '2026-11-02', kind: 'meal', status: 'done', updatedAt: NOW } },
    { store: 'photos', put: { id: 'p1', date: '2026-11-02', pose: 'front', width: 10, height: 10, bytes: 3, type: 'image/jpeg', createdAt: NOW } },
  ]);
  return d;
}

test('отчёт: только введённые данные, фото по умолчанию нет', () => {
  const d = withData();
  const { json, md } = buildReport(d, opts());
  assert.equal(json.schema_version, '1.0.0');
  assert.equal(json.report_type, 'monthly_review');
  assert.deepEqual(json.period, { from: '2026-11-02', to: '2026-12-01', days: 30 });
  assert.deepEqual(json.weights, [{ date: '2026-11-02', kg: 106.4 }, { date: '2026-11-30', kg: 103.9 }]);
  assert.equal(json.weight_summary!.change_kg, -2.5);
  assert.deepEqual(json.photos, []);
  const done = json.workouts.filter((x: any) => x.status === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].sets_marked, 6, 'отмечен только первый подход каждого упражнения');
  const sq = done[0].exercises.find((e: any) => e.exercise_id === 'goblet_squat')!;
  assert.equal(sq.weight_kg_used, 12);
  assert.deepEqual(sq.planned.weight_kg_range, [12, 16]);
  const kbRow = done[0].exercises.find((e: any) => e.exercise_id === 'kb_row')!;
  assert.equal(kbRow.weight_kg_used, null, 'плановый вес не выдаётся за фактический');
  assert.equal(json.nutrition_adherence.done, 1);
  assert.ok(json.nutrition_adherence.unknown > 100);
  assert.deepEqual(json.nutrition_adherence.relax_days, ['2026-11-29']);
  assert.ok(json.observations.some((o: string) => /без отметки/.test(o)));
  assert.match(md, /Отчёт за период 02\.11\.2026/);
  assert.match(md, /plan_update\.json/);
});

test('ZIP отчёта: JSON + Markdown + manifest, фото только по выбору', async () => {
  const d = withData();
  const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  const noPh = await buildReportZip(d, opts(), async () => photo);
  assert.equal(noPh.fileName, 'report_2026-11.zip');
  let z = await JSZip.loadAsync(noPh.bytes);
  assert.deepEqual(Object.keys(z.files).sort(), ['manifest.json', 'monthly_report.json', 'monthly_summary.md']);
  const manifest = JSON.parse(await z.file('manifest.json')!.async('string'));
  assert.equal(manifest.photos_included, false);
  assert.equal(manifest.files.length, 2);
  JSON.parse(await z.file('monthly_report.json')!.async('string'));
  const withPh = await buildReportZip(d, opts({ photos: [d.photos.p1] }), async () => photo);
  z = await JSZip.loadAsync(withPh.bytes);
  assert.ok(Object.keys(z.files).some((f) => f.startsWith('photos/') && f.endsWith('.jpg')));
});

test('резервная копия: полный круг с фото, шифрованием и проверкой целостности', async () => {
  const d = withData();
  const blobs = [{ id: 'p1', full: new Blob([new Uint8Array([9, 8, 7])], { type: 'image/jpeg' }), thumb: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) }];
  const { bytes, counts } = await buildBackupZip(d, blobs, 'test', NOW);
  assert.equal(counts.photoBlobs, 1);
  const parsed = await readBackup(bytes);
  assert.equal(parsed.photos.length, 1);
  assert.deepEqual(new Uint8Array(await parsed.photos[0].full.arrayBuffer()), new Uint8Array([9, 8, 7]));
  // восстановление «заменить» на «чистом устройстве»
  const restored = applyOps(emptyData(), restoreOps(parsed, 'replace', emptyData(), (s, r) => r[(STORE_KEYS as any)[s]]));
  assert.equal(restored.weights.w1.kg, 106.4);
  assert.equal(restored.trainingLogs['train:2026-11-02'].note, 'присед легко');
  assert.equal(Object.keys(restored.planDays).length, 30);
  // шифрование
  const enc = await encryptBytes(bytes, 'секрет-123', 1000);
  assert.ok(isEncrypted(enc));
  await assert.rejects(() => readBackup(enc), /пароль/);
  await assert.rejects(() => decryptBytes(enc, 'не тот'), /Неверный пароль/);
  const p2 = await readBackup(enc, 'секрет-123');
  assert.equal(p2.stores.weights.length, 2);
});

test('резервная копия: повреждённый файл не восстанавливается', async () => {
  const d = withData();
  const { bytes } = await buildBackupZip(d, [], 'test', NOW);
  const z = await JSZip.loadAsync(bytes);
  const body = JSON.parse(await z.file('backup.json')!.async('string'));
  body.stores.weights[0].kg = 50;
  z.file('backup.json', JSON.stringify(body));
  const tampered = await z.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => readBackup(tampered), /повреждён/);
});

test('объединение копий: остаётся более свежая запись', async () => {
  const d = withData();
  const { bytes } = await buildBackupZip(d, [], 'test', NOW);
  const parsed = await readBackup(bytes);
  const cur = apply(freshData(), [{ store: 'weights', put: { id: 'w9', date: '2026-11-10', kg: 105, createdAt: NOW } }]);
  const merged = apply(cur, restoreOps(parsed, 'merge', cur, (s, r) => r[(STORE_KEYS as any)[s]]));
  assert.equal(Object.keys(merged.weights).length, 3);
});
