import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, photoURL } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { go, useRoute } from '../app/router';
import { addDays, diffDays, fmtDayMonth, fmtFull, fmtShort, isISODate, parts, planMonthOf, type ISODate } from '../lib/dates';
import { fmtKg, fmtNum, fmtSigned, parseNum } from '../lib/util';
import {
  mealAdherence, mealRows, nextControlDay, smoothedTrend, trainingRows, trainingStats, weightSeries, weightSummary, workingWeights,
  type WeightPoint,
} from '../domain/stats';
import { exerciseName } from '../domain/templates';
import { DIFFICULTY_LABELS, POSE_LABELS, type PhotoMeta, type PhotoPose } from '../state/types';
import { Empty, Note, PageHead, Seg, Sheet, Switch, toast } from '../ui/kit';
import { WeightSheet } from './shared';
import { PiCamera, PiImages, PiPencilSimple, PiPlus, PiTrash, PiLock } from '../ui/icons';

type Tab = 'weight' | 'photos' | 'training' | 'nutrition';

export function ProgressScreen() {
  const data = useApp();
  const today = useToday();
  const route = useRoute();
  const tab = (route.query.get('tab') as Tab) || 'weight';
  const addParam = route.query.get('add');
  const [weighOpen, setWeighOpen] = useState(addParam === 'weight');
  useEffect(() => { if (addParam === 'weight') setWeighOpen(true); }, [addParam]);
  const ws = weightSummary(data);
  const photos = Object.values(data.photos);
  const allRows = useMemo(() => {
    const first = Object.keys(data.planDays).sort()[0] ?? today;
    return trainingRows(data, first < today ? first : today, today, today);
  }, [data, today]);
  const tstats = trainingStats(allRows);
  const ctrl = nextControlDay(data, today);
  const setTab = (t: Tab) => go('/progress', { tab: t }, true);

  return (
    <div className="page">
      <PageHead title="Прогресс" sub={`Цель: ${fmtNum(data.settings.goals.startWeightKg)} → ${fmtNum(data.settings.goals.targetWeightKg)} кг. Главное — вес и фото.`} />
      <div className="kpis">
        <div className="kpi lead">
          <span className="k-label">Текущий вес</span>
          {ws.last ? <span className="k-value">{fmtKg(ws.last.kg)}</span> : <span className="k-value sm">Недостаточно данных</span>}
          <span className="k-sub">{ws.last ? `замер ${fmtDayMonth(ws.last.date)}` : 'добавьте первое взвешивание'}</span>
        </div>
        <div className="kpi">
          <span className="k-label">Изменение веса</span>
          {ws.change != null ? <span className="k-value">{fmtSigned(ws.change)} кг</span> : <span className="k-value sm">Недостаточно данных</span>}
          <span className="k-sub">{ws.change != null ? `с ${fmtDayMonth(ws.first!.date)}${ws.toTarget != null ? `, до цели ${fmtNum(Math.max(0, ws.toTarget))} кг` : ''}` : 'нужно минимум 2 замера'}</span>
        </div>
        <div className="kpi">
          <span className="k-label">Тренировок завершено</span>
          <span className="k-value">{tstats.done}</span>
          <span className="k-sub">{tstats.planned ? `из ${tstats.planned}, срок которых наступил` : 'с начала плана'}</span>
        </div>
        <div className="kpi">
          <span className="k-label">Фотосравнение</span>
          <span className="k-value sm">{photos.length >= 2 ? `${photos.length} фото` : photos.length === 1 ? '1 фото' : 'Нет фото'}</span>
          <span className="k-sub">{photos.length >= 2 ? <button className="btn ghost small" style={{ padding: 0, minHeight: 0 }} onClick={() => setTab('photos')}>Сравнить</button> : 'для сравнения нужно 2 фото'}</span>
        </div>
        <div className="kpi">
          <span className="k-label">Контрольный день</span>
          <span className="k-value sm">{ctrl ? (ctrl.date === today ? 'Сегодня' : fmtDayMonth(ctrl.date)) : '—'}</span>
          <span className="k-sub">{ctrl ? (ctrl.kind === 'weigh' ? 'взвешивание' : 'фото прогресса') : 'замеры отключены в настройках'}</span>
        </div>
      </div>
      <div style={{ margin: '18px 0 12px' }}>
        <Seg value={tab} onChange={setTab} label="Раздел" options={[
          { value: 'weight', label: 'Вес' }, { value: 'photos', label: 'Фото' }, { value: 'training', label: 'Тренировки' }, { value: 'nutrition', label: 'Питание' },
        ]} />
      </div>
      {tab === 'weight' && <WeightSection onAdd={() => setWeighOpen(true)} />}
      {tab === 'photos' && <PhotosSection addDate={isISODate(addParam) ? addParam! : null} />}
      {tab === 'training' && <TrainingSection />}
      {tab === 'nutrition' && <NutritionSection />}
      <WeightSheet open={weighOpen} date={today} onClose={() => { setWeighOpen(false); if (addParam) go('/progress', { tab }, true); }} />
    </div>
  );
}

// ------------------------------------------------------------------ вес

function WeightChart({ points, trend, target }: { points: WeightPoint[]; trend: WeightPoint[]; target: number }) {
  const W = 720, H = 300, padL = 44, padR = 16, padT = 18, padB = 34;
  const all = [...points, ...trend];
  const ys = all.map((p) => p.kg);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const showTarget = target >= lo - 3 && target <= hi + 3;
  if (showTarget) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
  lo = Math.floor(lo - 0.5); hi = Math.ceil(hi + 0.5);
  const d0 = points[0].date, d1 = points[points.length - 1].date;
  const span = Math.max(1, diffDays(d1, d0));
  const x = (d: ISODate) => padL + (points.length === 1 ? (W - padL - padR) / 2 : (diffDays(d, d0) / span) * (W - padL - padR));
  const y = (kg: number) => padT + ((hi - kg) / (hi - lo)) * (H - padT - padB);
  const yTicks: number[] = [];
  const step = hi - lo > 12 ? 4 : hi - lo > 6 ? 2 : 1;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(v);
  const xTicks: ISODate[] = [];
  const xStep = span > 120 ? 30 : span > 42 ? 14 : 7;
  for (let i = 0; i <= span; i += xStep) xTicks.push(addDays(d0, i));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ');
  const tpath = trend.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ');
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`График веса: ${points.map((p) => `${fmtShort(p.date)} ${fmtNum(p.kg)} кг`).join(', ')}`}>
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="grid" />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="axis">{v}</text>
        </g>
      ))}
      {points.length > 1 && xTicks.map((d) => <text key={d} x={x(d)} y={H - 10} textAnchor="middle" className="axis">{fmtShort(d)}</text>)}
      {showTarget && (
        <g>
          <line x1={padL} x2={W - padR} y1={y(target)} y2={y(target)} className="target" />
          <text x={W - padR} y={y(target) - 6} textAnchor="end" className="target-label">цель {fmtNum(target)} кг</text>
        </g>
      )}
      {trend.length > 1 && <path d={tpath} className="trend" />}
      {points.length > 1 && <path d={path} className="line" />}
      {points.map((p, i) => <circle key={p.date} cx={x(p.date)} cy={y(p.kg)} r={i === points.length - 1 ? 6 : 4.5} className={`dot${i === points.length - 1 ? ' last' : ''}`} />)}
      {points.length <= 12 && points.map((p) => <text key={`v${p.date}`} x={x(p.date)} y={y(p.kg) - 12} textAnchor="middle" className="val">{fmtNum(p.kg)}</text>)}
      {points.length === 1 && <text x={x(points[0].date)} y={H - 10} textAnchor="middle" className="axis">{fmtFull(points[0].date)}</text>}
    </svg>
  );
}

function monthlyAverages(points: WeightPoint[]): WeightPoint[] {
  const m = new Map<string, number[]>();
  for (const p of points) {
    const { y, m: mo } = parts(p.date);
    const k = `${y}-${String(mo).padStart(2, '0')}-15`;
    m.set(k, [...(m.get(k) ?? []), p.kg]);
  }
  return [...m.entries()].sort().map(([date, xs]) => ({ date, kg: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 }));
}

function WeightSection({ onAdd }: { onAdd: () => void }) {
  const data = useApp();
  const today = useToday();
  const [view, setView] = useState<'weeks' | 'months'>('weeks');
  const [edit, setEdit] = useState<string | null>(null);
  const all = weightSeries(data);
  const pts = view === 'weeks' ? all.filter((p) => p.date >= addDays(today, -84)) : monthlyAverages(all);
  const trend = view === 'weeks' ? smoothedTrend(pts) : [];
  const ws = weightSummary(data);
  const entries = Object.values(data.weights).sort((a, b) => (a.date + a.createdAt < b.date + b.createdAt ? 1 : -1));
  return (
    <div className="cols">
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h2>Вес</h2>
            <div className="row">
              <Seg value={view} onChange={setView} label="Масштаб" options={[{ value: 'weeks', label: 'Недели' }, { value: 'months', label: 'Месяцы' }]} />
              <button className="btn primary small" onClick={onAdd}><PiPlus /> Вес</button>
            </div>
          </div>
          {pts.length === 0 ? (
            <Empty title="Недостаточно данных" actions={<button className="btn primary" onClick={onAdd}>Добавить вес</button>}>
              График появится после первого взвешивания. Без фактических замеров честно показать динамику нельзя.
            </Empty>
          ) : (
            <>
              <WeightChart points={pts} trend={trend} target={data.settings.goals.targetWeightKg} />
              <p className="hint">
                {pts.length === 1 ? 'Один замер — для линии нужен ещё хотя бы один. ' : ''}
                {view === 'weeks' && !trend.length && pts.length > 1 ? 'Сглаженная тенденция появится, когда будет 4+ замера за 2+ недели. ' : ''}
                {trend.length ? 'Пунктир — сглаженная тенденция (скользящее среднее ±7 дней). ' : ''}
                {view === 'months' ? 'Точка — среднее за месяц.' : ''}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="stack">
        <div className="card">
          <h3>Сводка</h3>
          <table className="table"><tbody>
            <tr><td>Старт по плану</td><td className="n">{fmtKg(data.settings.goals.startWeightKg)}</td></tr>
            <tr><td>Цель</td><td className="n">{fmtKg(data.settings.goals.targetWeightKg)}</td></tr>
            <tr><td>Первый замер</td><td className="n">{ws.first ? `${fmtKg(ws.first.kg)}, ${fmtShort(ws.first.date)}` : '—'}</td></tr>
            <tr><td>Последний</td><td className="n">{ws.last ? `${fmtKg(ws.last.kg)}, ${fmtShort(ws.last.date)}` : '—'}</td></tr>
            <tr><td>Темп тенденции</td><td className="n">{ws.rate != null ? `${fmtSigned(ws.rate, 2)} кг/нед` : 'недостаточно данных'}</td></tr>
          </tbody></table>
        </div>
        <div className="card">
          <h3>Записи</h3>
          {entries.length === 0 ? <p className="muted small mt0">Пока пусто.</p> : (
            <div className="list">
              {entries.slice(0, 40).map((w) => (
                <div className="li" key={w.id}>
                  <span className="grow"><b className="num">{fmtKg(w.kg)}</b> <span className="muted small">{fmtFull(w.date)}</span></span>
                  <button className="icon-btn" aria-label="Изменить" onClick={() => setEdit(w.id)}><PiPencilSimple /></button>
                  <button className="icon-btn" aria-label="Удалить" onClick={() => { if (confirm(`Удалить запись ${fmtNum(w.kg)} кг от ${fmtShort(w.date)}?`)) A.deleteWeight(w.id); }}><PiTrash /></button>
                </div>
              ))}
            </div>
          )}
        </div>
        <WaistCard />
      </div>
      <EditWeightSheet id={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function EditWeightSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const data = useApp();
  const w = id ? data.weights[id] : null;
  const [kg, setKg] = useState('');
  const [date, setDate] = useState('');
  useEffect(() => { if (w) { setKg(String(w.kg).replace('.', ',')); setDate(w.date); } }, [id]);
  if (!w) return null;
  return (
    <Sheet open onClose={onClose} title="Изменить замер">
      <label className="field"><span>Вес, кг</span><input className="input num-input" inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} /></label>
      <label className="field"><span>Дата</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button className="btn primary block" onClick={() => {
        const v = parseNum(kg);
        if (v == null || v < 30 || v > 300 || !isISODate(date)) { toast('Проверьте вес и дату'); return; }
        A.updateWeight(w.id, date, Math.round(v * 10) / 10);
        onClose();
      }}>Сохранить</button>
    </Sheet>
  );
}

function WaistCard() {
  const data = useApp();
  const today = useToday();
  const [text, setText] = useState('');
  if (!data.settings.showWaist) {
    return <div className="card flat"><Switch checked={false} onChange={(v) => A.updateSettings({ showWaist: v })} label="Показывать обхват талии" hint="Необязательная метрика, по умолчанию скрыта" /></div>;
  }
  const ms = Object.values(data.measurements).sort((a, b) => (a.date < b.date ? 1 : -1));
  return (
    <div className="card">
      <div className="card-head"><h3>Талия (необязательно)</h3><button className="btn ghost small" onClick={() => A.updateSettings({ showWaist: false })}>Скрыть</button></div>
      <div className="row nowrap">
        <input className="input" inputMode="decimal" placeholder="см" value={text} onChange={(e) => setText(e.target.value)} aria-label="Обхват талии, см" />
        <button className="btn" onClick={() => { const v = parseNum(text); if (v == null || v < 40 || v > 250) { toast('Введите обхват в сантиметрах'); return; } A.addWaist(today, v); setText(''); }}>Добавить</button>
      </div>
      <div className="list">
        {ms.slice(0, 12).map((m) => (
          <div className="li" key={m.id}><span className="grow"><b className="num">{fmtNum(m.waistCm)} см</b> <span className="muted small">{fmtFull(m.date)}</span></span>
            <button className="icon-btn" aria-label="Удалить" onClick={() => A.deleteWaist(m.id)}><PiTrash /></button></div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ фото

function useThumb(id: string, kind: 'thumb' | 'full' = 'thumb') {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    photoURL(id, kind).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [id, kind]);
  return url;
}

function Thumb({ p, selected, badge, onClick }: { p: PhotoMeta; selected?: boolean; badge?: string; onClick: () => void }) {
  const url = useThumb(p.id);
  return (
    <button className={`thumb${selected ? ' sel' : ''}`} onClick={onClick} aria-label={`Фото ${fmtFull(p.date)}${p.pose ? `, ${POSE_LABELS[p.pose]}` : ''}`} aria-pressed={selected}>
      {url && <img src={url} alt="" />}
      <span className="cap">{fmtShort(p.date)}{p.pose ? `, ${POSE_LABELS[p.pose]}` : ''}</span>
      {badge && <span className="badge">{badge}</span>}
    </button>
  );
}

function PhotosSection({ addDate }: { addDate: ISODate | null }) {
  const data = useApp();
  const today = useToday();
  const [date, setDate] = useState(addDate ?? today);
  const [pose, setPose] = useState<PhotoPose | ''>('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [mode, setMode] = useState<'slider' | 'side'>('slider');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (addDate) setDate(addDate); }, [addDate]);
  const photos = Object.values(data.photos).sort((a, b) => (a.date + a.createdAt < b.date + b.createdAt ? 1 : -1));
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await A.addPhoto(f, date, pose || null);
      toast(files.length > 1 ? `Добавлено фото: ${files.length}` : 'Фото добавлено');
    } catch (e: any) {
      toast(e?.message || 'Не удалось добавить фото');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const toggleSel = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  const pair = sel.map((id) => data.photos[id]).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
  return (
    <div className="cols">
      <div className="stack">
        {pair.length === 2 && (
          <div className="card">
            <div className="card-head">
              <h2>До и после</h2>
              <Seg value={mode} onChange={setMode} label="Вид сравнения" options={[{ value: 'slider', label: 'Слайдер' }, { value: 'side', label: 'Рядом' }]} />
            </div>
            <p className="muted small mt0">{fmtFull(pair[0].date)} и {fmtFull(pair[1].date)}: {diffDays(pair[1].date, pair[0].date)} дн. между снимками.</p>
            {mode === 'slider' ? <CompareSlider a={pair[0]} b={pair[1]} /> : <SideBySide a={pair[0]} b={pair[1]} />}
          </div>
        )}
        <div className="card">
          <div className="card-head">
            <h2>Галерея</h2>
            {photos.length >= 2 && (
              <button className="btn small" aria-pressed={selecting} onClick={() => { setSelecting(!selecting); if (selecting) setSel([]); }}>
                <PiImages /> {selecting ? 'Готово' : 'Сравнить два фото'}
              </button>
            )}
          </div>
          {selecting && <p className="hint mt0">Выберите два снимка — сравнение появится выше.</p>}
          {photos.length === 0 ? <Empty title="Фото пока нет">Снимайте раз в месяц при одинаковом свете, в одной позе и одежде — так сравнение честнее.</Empty> : (
            <div className="gallery">
              {photos.map((p) => (
                <Thumb key={p.id} p={p} selected={sel.includes(p.id)} badge={sel.includes(p.id) ? String(pair.findIndex((x) => x.id === p.id) + 1 || '') : undefined}
                  onClick={() => (selecting ? toggleSel(p.id) : setViewer(p.id))} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="stack">
        <div className="card">
          <h3><PiCamera style={{ display: 'inline', verticalAlign: '-4px' }} /> Добавить фото</h3>
          <label className="field"><span>Дата</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value || today)} /></label>
          <div className="field">
            <span className="field-label">Положение (необязательно)</span>
            <Seg value={pose} onChange={setPose} label="Положение" options={[{ value: '' as const, label: 'не указано' }, { value: 'front' as const, label: 'спереди' }, { value: 'side' as const, label: 'сбоку' }, { value: 'back' as const, label: 'сзади' }]} />
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e.target.files)} />
          <button className="btn primary block" disabled={busy} onClick={() => fileRef.current?.click()}><PiPlus /> {busy ? 'Сохраняю…' : 'Выбрать или снять фото'}</button>
          <p className="hint">Фото уменьшается до {data.settings.photoMaxSide ? `${data.settings.photoMaxSide} пикселей по длинной стороне` : 'исходного размера (без уменьшения)'} — меняется в настройках.</p>
        </div>
        <Note kind="ok" icon={<PiLock />}>Фото хранятся только на этом устройстве. Распознавания лица и автоматической оценки тела нет. В отчёт для ChatGPT фото попадают только если вы сами их выберете.</Note>
      </div>
      <PhotoViewer id={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

function CompareSlider({ a, b }: { a: PhotoMeta; b: PhotoMeta }) {
  const ua = useThumb(a.id, 'full'), ub = useThumb(b.id, 'full');
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div>
      <div className="compare" ref={box} style={{ width: '100%', maxWidth: 520 }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); move(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons) move(e.clientX); }}>
        {ub && <img src={ub} alt={`После, ${fmtFull(b.date)}`} />}
        {ua && <img src={ua} alt={`До, ${fmtFull(a.date)}`} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />}
        <span className="handle" style={{ left: `calc(${pos}% - 1.5px)` }} />
        <span className="lab" style={{ left: 8 }}>{fmtShort(a.date)}</span>
        <span className="lab" style={{ right: 8 }}>{fmtShort(b.date)}</span>
      </div>
      <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Положение разделителя" style={{ width: '100%', maxWidth: 520, marginTop: 10 }} />
    </div>
  );
}

function SideBySide({ a, b }: { a: PhotoMeta; b: PhotoMeta }) {
  const ua = useThumb(a.id, 'full'), ub = useThumb(b.id, 'full');
  return (
    <div className="side-by-side">
      <figure>{ua && <img src={ua} alt="" />}<figcaption>{fmtFull(a.date)}{a.pose ? `, ${POSE_LABELS[a.pose]}` : ''}</figcaption></figure>
      <figure>{ub && <img src={ub} alt="" />}<figcaption>{fmtFull(b.date)}{b.pose ? `, ${POSE_LABELS[b.pose]}` : ''}</figcaption></figure>
    </div>
  );
}

function PhotoViewer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const data = useApp();
  const p = id ? data.photos[id] : null;
  const url = useThumb(id ?? '', 'full');
  if (!p) return null;
  return (
    <Sheet open onClose={onClose} title={`Фото ${fmtFull(p.date)}`} wide>
      {url && <img src={url} alt="" style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: 12, background: '#000' }} />}
      <div className="row" style={{ marginTop: 12 }}>
        <label className="field grow" style={{ margin: 0 }}><span>Дата</span><input className="input" type="date" value={p.date} onChange={(e) => e.target.value && A.updatePhoto(p.id, { date: e.target.value })} /></label>
        <div className="field" style={{ margin: 0 }}>
          <span className="field-label">Положение</span>
          <Seg value={p.pose ?? ''} onChange={(v) => A.updatePhoto(p.id, { pose: (v || null) as PhotoPose | null })} label="Положение"
            options={[{ value: '', label: '—' }, { value: 'front', label: 'спереди' }, { value: 'side', label: 'сбоку' }, { value: 'back', label: 'сзади' }]} />
        </div>
      </div>
      <p className="hint">{p.width}×{p.height}, {Math.round(p.bytes / 1024)} КБ. Хранится только на устройстве.</p>
      <button className="btn danger" onClick={() => { if (confirm('Удалить это фото? Отменить нельзя (если нет резервной копии).')) { A.deletePhoto(p.id); onClose(); } }}><PiTrash /> Удалить фото</button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ тренировки и питание

function usePeriod() {
  const data = useApp();
  const today = useToday();
  const [p, setP] = useState<'month' | '30' | 'all'>('month');
  const pm = planMonthOf(today, data.settings.monthStartDay);
  const first = Object.keys(data.planDays).sort()[0] ?? today;
  const range = p === 'month' ? pm : p === '30' ? { from: addDays(today, -29), to: today } : { from: first < today ? first : today, to: today > first ? today : first };
  return { p, setP, range, today };
}

function PeriodSeg({ p, setP, range }: ReturnType<typeof usePeriod>) {
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <Seg value={p} onChange={setP} label="Период" options={[{ value: 'month' as const, label: 'План-месяц' }, { value: '30' as const, label: '30 дней' }, { value: 'all' as const, label: 'Всё время' }]} />
      <span className="muted small">{fmtFull(range.from)} — {fmtFull(range.to)}</span>
    </div>
  );
}

function TrainingSection() {
  const data = useApp();
  const per = usePeriod();
  const rows = useMemo(() => trainingRows(data, per.range.from, per.range.to, per.today), [data, per.range.from, per.range.to, per.today]);
  const s = trainingStats(rows);
  const ww = workingWeights(data, per.range.from, per.range.to);
  return (
    <>
      <PeriodSeg {...per} />
      <div className="cols">
        <div className="card">
          <h2>Выполнение</h2>
          {s.planned + s.upcoming + s.postponed === 0 ? <p className="muted mt0">В этом периоде тренировок нет.</p> : (
            <>
              <div className="meter" style={{ margin: '4px 0 12px' }}><i style={{ width: `${s.planned ? (s.done / s.planned) * 100 : 0}%`, background: 'var(--iron)' }} /></div>
              <table className="table"><tbody>
                <tr><td>Выполнено</td><td className="n">{s.done}</td></tr>
                <tr><td>Запланировано (срок наступил)</td><td className="n">{s.planned}</td></tr>
                <tr><td>Перенесено</td><td className="n">{s.moved}</td></tr>
                <tr><td>Пропущено</td><td className="n">{s.skipped}</td></tr>
                <tr><td>Без отметки (не считается пропуском)</td><td className="n">{s.notLogged}</td></tr>
                {s.postponed > 0 && <tr><td>Отложено до начала занятий</td><td className="n">{s.postponed}</td></tr>}
                <tr><td>Впереди</td><td className="n">{s.upcoming}</td></tr>
                <tr><td>Силовых / степпер</td><td className="n">{s.strengthDone} / {s.cardioDone}</td></tr>
                <tr><td>Минуты степпера (кардио + разминка)</td><td className="n">{s.stepperMinutes} + {s.warmupMinutes}</td></tr>
              </tbody></table>
            </>
          )}
        </div>
        <div className="card">
          <h2>Рабочие веса</h2>
          <p className="muted small mt0">Только введённые вами значения — плановые диапазоны сюда не попадают.</p>
          {Object.keys(ww).length === 0 ? <p className="muted">Нет данных за период.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Упражнение</th><th>Даты и вес</th></tr></thead>
                <tbody>
                  {Object.entries(ww).map(([id, xs]) => (
                    <tr key={id}><td>{exerciseName(id)}</td><td>{xs.map((x) => `${fmtShort(x.date)}: ${fmtNum(x.kg)} кг${x.difficulty ? ` (${DIFFICULTY_LABELS[x.difficulty]})` : ''}`).join('; ')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function NutritionSection() {
  const data = useApp();
  const per = usePeriod();
  const rows = useMemo(() => mealRows(data, per.range.from, per.range.to, per.today), [data, per.range.from, per.range.to, per.today]);
  const a = mealAdherence(rows);
  return (
    <>
      <PeriodSeg {...per} />
      <div className="cols">
        <div className="card">
          <h2>План питания</h2>
          {a.planned === 0 ? <p className="muted mt0">В этом периоде нет прошедших плановых приёмов пищи.</p> : (
            <>
              <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 12 }}>
                <div className="kpi"><span className="k-label">Выполнено из отмеченных</span><span className="k-value">{a.percentOfMarked != null ? `${a.percentOfMarked}%` : '—'}</span></div>
                <div className="kpi"><span className="k-label">Отмечено</span><span className="k-value">{a.done + a.skipped} из {a.planned}</span></div>
              </div>
              <table className="table"><tbody>
                <tr><td>Съедено по плану</td><td className="n">{a.done}</td></tr>
                <tr><td>Пропущено или заменено</td><td className="n">{a.skipped}</td></tr>
                <tr><td>Без отметки</td><td className="n">{a.unknown}</td></tr>
              </tbody></table>
              {a.relaxDays.length > 0 && <p className="hint">Релакс-дни не учитываются: {a.relaxDays.map(fmtShort).join(', ')}.</p>}
            </>
          )}
        </div>
        <div className="card">
          <h2>По дням</h2>
          <div className="list">
            {rows.filter((r) => r.date <= per.today).slice(-14).reverse().map((r) => (
              <div className="li" key={r.date}>
                <span className="num" style={{ width: 54 }}>{fmtShort(r.date)}</span>
                {r.relax ? <span className="chip rose">релакс-день</span> : (
                  <span className="chips">
                    {r.meals.map((m) => <span key={m.slot} className={`chip ${m.status === 'done' ? 'accent' : m.status === 'skipped' ? 'outline' : ''}`} title={m.dish}>{m.slot === 'breakfast' ? 'З' : m.slot === 'lunch' ? 'О' : m.slot === 'snack' ? 'П' : 'У'}{m.status === 'done' ? ' ✓' : m.status === 'skipped' ? ' —' : ''}</span>)}
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="hint">З — завтрак, О — обед, П — перекус, У — ужин. Серые — без отметки.</p>
        </div>
      </div>
    </>
  );
}
