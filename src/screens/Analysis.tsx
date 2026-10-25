import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, getAllPhotoBlobs, getPhotoBlob, commit, replaceAll, photoURL } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { go, href, useRoute } from '../app/router';
import { addDays, addMonths, endOfMonth, fmtFull, fmtShort, isISODate, startOfMonth, type ISODate } from '../lib/dates';
import { fmtBytes, nowStamp, uid } from '../lib/util';
import { CHATGPT_PROMPT } from '../domain/report';
import { buildBackupZip, buildReportZip, encryptBytes, isEncrypted, readBackup, restoreOps, type ParsedBackup } from '../domain/zipfiles';
import { buildApplyOps, CHANGE_TYPE_LABELS, latestAppliedPatch, parsePlanUpdate, rollbackOps, type ParseResult } from '../domain/planUpdate';
import { planRange } from '../domain/tasks';
import { STORE_KEYS, type PhotoMeta } from '../state/types';
import { copyText, readFileBytes, readFileText, saveFile } from '../lib/files';
import { Disclosure, Empty, Note, PageHead, Seg, Switch, toast } from '../ui/kit';
import {
  PiArrowCounterClockwise, PiCheck, PiCopy, PiDownloadSimple, PiFileZip, PiLock, PiShieldCheck, PiUploadSimple, PiWarning, PiChatsCircle,
} from '../ui/icons';

type Tab = 'report' | 'import' | 'backup' | 'history';

export function AnalysisScreen() {
  const route = useRoute();
  const tab = (route.query.get('tab') as Tab) || 'report';
  return (
    <div className="page">
      <PageHead title="Анализ с ChatGPT" sub="Ежемесячный отчёт, обновлённый план и резервные копии. Всё формируется на устройстве, без интернета." />
      <div style={{ marginBottom: 16 }}>
        <Seg value={tab} onChange={(t) => go('/analysis', { tab: t }, true)} label="Раздел" options={[
          { value: 'report', label: 'Отчёт' }, { value: 'import', label: 'Импорт плана' }, { value: 'backup', label: 'Резервная копия' }, { value: 'history', label: 'История' },
        ]} />
      </div>
      {tab === 'report' && <ReportSection />}
      {tab === 'import' && <ImportSection />}
      {tab === 'backup' && <BackupSection />}
      {tab === 'history' && <HistorySection />}
    </div>
  );
}

// ------------------------------------------------------------------ отчёт

function defaultPeriod(today: ISODate, plan: { from: ISODate; to: ISODate } | null): { key: string; from: ISODate; to: ISODate } {
  if (plan) {
    const first30 = { from: plan.from, to: addDays(plan.from, 29) };
    if (today <= addDays(first30.to, 31)) return { key: 'first30', ...first30 };
  }
  const prev = addMonths(startOfMonth(today), -1);
  return { key: 'prev', from: prev, to: endOfMonth(prev) };
}

function PhotoPick({ p, on, toggle }: { p: PhotoMeta; on: boolean; toggle: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { photoURL(p.id, 'thumb').then(setUrl); }, [p.id]);
  return (
    <button className={`thumb${on ? ' sel' : ''}`} onClick={toggle} aria-pressed={on} aria-label={`Фото ${fmtFull(p.date)}`}>
      {url && <img src={url} alt="" />}
      <span className="cap">{fmtShort(p.date)}</span>
      {on && <span className="badge"><PiCheck /></span>}
    </button>
  );
}

function ReportSection() {
  const data = useApp();
  const today = useToday();
  const plan = planRange(data);
  const def = useMemo(() => defaultPeriod(today, plan), [today, plan?.from]);
  const [pkey, setPkey] = useState(def.key);
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [inc, setInc] = useState({ weights: true, workouts: true, nutrition: true, notes: true });
  const [withPhotos, setWithPhotos] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ bytes: Uint8Array; fileName: string; counts: Record<string, number>; observations: string[] } | null>(null);

  const choose = (k: string) => {
    setPkey(k);
    setResult(null);
    if (k === 'first30' && plan) { setFrom(plan.from); setTo(addDays(plan.from, 29)); }
    if (k === 'prev') { const p = addMonths(startOfMonth(today), -1); setFrom(p); setTo(endOfMonth(p)); }
    if (k === 'cur') { setFrom(startOfMonth(today)); setTo(endOfMonth(today)); }
  };
  const periodPhotos = Object.values(data.photos).filter((p) => p.date >= from && p.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1));
  const allPhotos = Object.values(data.photos).sort((a, b) => (a.date < b.date ? -1 : 1));
  const valid = isISODate(from) && isISODate(to) && from <= to;

  const build = async () => {
    if (!valid) return;
    setBusy(true);
    setResult(null);
    try {
      const photos = withPhotos ? allPhotos.filter((p) => picked.includes(p.id)) : [];
      const r = await buildReportZip(data, {
        from, to, today, photos, notes, include: inc, appVersion: __APP_VERSION__, generatedAt: new Date().toISOString(),
      }, async (id) => (await getPhotoBlob(id))?.full ?? null);
      setResult({ bytes: r.bytes, fileName: r.fileName, counts: r.counts, observations: r.json.observations });
      await A.addExportRecord({ kind: 'monthly_report', fileName: r.fileName, period: { from, to }, includedPhotos: r.counts.photos, counts: r.counts, bytes: r.bytes.length });
    } catch (e: any) {
      toast(`Не удалось сформировать отчёт: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cols">
      <div className="stack">
        <div className="card">
          <h2>Как это работает</h2>
          <ol className="steps-explain">
            <li><span>Нажмите «Выгрузить отчёт за месяц» и сохраните ZIP в «Файлы».</span></li>
            <li><span>Откройте ChatGPT, приложите ZIP и вставьте запрос кнопкой «Скопировать запрос». Приложение ничего не отправляет само.</span></li>
            <li><span>Попросите ChatGPT прислать <code>plan_update.json</code> и загрузите его во вкладке «Импорт плана» — каждое изменение вы подтвердите сами.</span></li>
          </ol>
        </div>
        <div className="card">
          <h2>Период</h2>
          <Seg value={pkey} onChange={choose} label="Период" options={[
            ...(plan ? [{ value: 'first30', label: 'Первые 30 дней плана' }] : []),
            { value: 'prev', label: 'Прошлый месяц' }, { value: 'cur', label: 'Этот месяц' }, { value: 'custom', label: 'Свой' },
          ]} />
          <div className="row nowrap" style={{ marginTop: 12 }}>
            <label className="field grow"><span>С</span><input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPkey('custom'); setResult(null); }} /></label>
            <label className="field grow"><span>По</span><input className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPkey('custom'); setResult(null); }} /></label>
          </div>
          {!valid && <p className="error-text">Проверьте даты периода.</p>}
          <h3 style={{ marginTop: 8 }}>Что будет передано</h3>
          <Switch checked={inc.weights} onChange={(v) => setInc({ ...inc, weights: v })} label="Вес" hint="Только введённые взвешивания" />
          <Switch checked={inc.workouts} onChange={(v) => setInc({ ...inc, workouts: v })} label="Тренировки" hint="Даты, подходы, рабочие веса, сложность, переносы, пропуски, самочувствие" />
          <Switch checked={inc.nutrition} onChange={(v) => setInc({ ...inc, nutrition: v })} label="Питание" hint="Отметки «съел/пропустил» по меню, без КБЖУ" />
          <Switch checked={inc.notes} onChange={(v) => setInc({ ...inc, notes: v })} label="Заметки по дням" />
          <hr className="divider" />
          <Switch checked={withPhotos} onChange={(v) => { setWithPhotos(v); setResult(null); }} label="Включить фотографии в отчёт" hint="По умолчанию выключено. Фото тела — личные данные: выберите конкретные снимки." />
          {withPhotos && (
            allPhotos.length === 0 ? <p className="muted small">Фото нет.</p> : (
              <>
                <p className="hint mt0">Выбрано: {picked.length}. {periodPhotos.length ? `За период — ${periodPhotos.length}.` : ''}</p>
                <div className="gallery">
                  {allPhotos.map((p) => <PhotoPick key={p.id} p={p} on={picked.includes(p.id)} toggle={() => setPicked((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))} />)}
                </div>
              </>
            )
          )}
          <label className="field" style={{ marginTop: 14 }}>
            <span>Комментарий для ChatGPT (необязательно)</span>
            <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Например: неделю болел, тренировки 10–14 ноября переносил" />
          </label>
          <button className="btn primary big block" disabled={busy || !valid} onClick={build}><PiFileZip /> {busy ? 'Формирую…' : 'Выгрузить отчёт за месяц'}</button>
        </div>
      </div>
      <div className="stack sticky-col">
        {result && (
          <div className="card" style={{ borderLeft: '5px solid var(--accent)' }}>
            <h3>Отчёт готов</h3>
            <p className="mt0"><b>{result.fileName}</b>, {fmtBytes(result.bytes.length)}</p>
            <p className="small muted mt0">Внутри: monthly_report.json, monthly_summary.md, manifest.json{result.counts.photos ? `, фото: ${result.counts.photos}` : ', без фото'}. Взвешиваний: {result.counts.weights}, тренировок с отметками: {result.counts.workouts}.</p>
            <div className="btn-row">
              <button className="btn primary" onClick={async () => { const r = await saveFile(result.bytes, result.fileName, 'application/zip'); if (r !== 'cancelled') toast(r === 'shared' ? 'Отчёт передан' : 'Отчёт сохранён'); }}><PiDownloadSimple /> Сохранить или поделиться</button>
            </div>
            {result.observations.length > 0 && (
              <Disclosure summary="Что отмечено в данных">
                <ul className="tech-list small">{result.observations.map((o, i) => <li key={i}>{o}</li>)}</ul>
              </Disclosure>
            )}
          </div>
        )}
        <div className="card">
          <h3><PiChatsCircle style={{ display: 'inline', verticalAlign: '-4px' }} /> Запрос для ChatGPT</h3>
          <p className="small mt0" style={{ maxHeight: 180, overflow: 'auto' }}>{CHATGPT_PROMPT}</p>
          <button className="btn soft block" onClick={async () => { (await copyText(CHATGPT_PROMPT)) ? toast('Запрос скопирован') : toast('Не удалось скопировать'); }}><PiCopy /> Скопировать запрос для ChatGPT</button>
          <p className="hint">Схема plan_update.json уже есть в конце monthly_summary.md — ChatGPT увидит её в архиве.</p>
        </div>
        <Note kind="plain">Без данных о сложности и рабочих весах рекомендации по нагрузке будут осторожными — вводите их в тренировках, когда удобно.</Note>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ импорт обновления

function ImportSection() {
  const data = useApp();
  const today = useToday();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [paste, setPaste] = useState(false);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [risk, setRisk] = useState<Record<string, boolean>>({});

  const check = (t: string, name: string) => {
    const r = parsePlanUpdate(t, data, today);
    setFileName(name);
    setParsed(r);
    if (r.ok) {
      setSel(Object.fromEntries(r.changes.map((c) => [c.key, c.applicable && !c.danger])));
      setRisk({});
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try { check(await readFileText(f), f.name); } catch (e: any) { setParsed({ ok: false, errors: [{ path: 'файл', message: e?.message || 'не удалось прочитать' }] }); }
    if (fileRef.current) fileRef.current.value = '';
  };
  const apply = async () => {
    if (!parsed?.ok) return;
    const chosen = new Set(Object.entries(sel).filter(([k, v]) => v && (!parsed.changes.find((c) => c.key === k)?.danger || risk[k])).map(([k]) => k));
    if (!chosen.size) { toast('Не выбрано ни одного изменения'); return; }
    const pid = uid('patch');
    const { ops } = buildApplyOps(data, parsed, chosen, fileName || 'plan_update.json', nowStamp(), pid);
    await commit(ops);
    toast(`Применено изменений: ${chosen.size}. Можно откатить во вкладке «История».`);
    setParsed(null);
    setText('');
    go('/analysis', { tab: 'history' }, true);
  };
  const latest = latestAppliedPatch(data);

  return (
    <div className="cols">
      <div className="stack">
        <div className="card">
          <h2>Загрузить обновлённый план от ChatGPT</h2>
          <p className="muted mt0">Файл <code>plan_update.json</code> проверяется на устройстве. Ничего не меняется, пока вы не подтвердите изменения. Прошлые отметки, вес и фото не затрагиваются.</p>
          <input ref={fileRef} type="file" accept=".json,application/json,text/plain" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
          <div className="btn-row">
            <button className="btn primary big" onClick={() => fileRef.current?.click()}><PiUploadSimple /> Загрузить обновлённый план от ChatGPT</button>
            <button className="btn" onClick={() => setPaste(!paste)} aria-pressed={paste}>Вставить текст JSON</button>
          </div>
          {paste && (
            <div style={{ marginTop: 12 }}>
              <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"schema_version": "1.0.0", "update_type": "plan_update", ...}' aria-label="Текст plan_update.json" />
              <button className="btn" style={{ marginTop: 8 }} disabled={!text.trim()} onClick={() => check(text, 'вставленный текст')}>Проверить</button>
            </div>
          )}
        </div>

        {parsed && !parsed.ok && (
          <div className="card" style={{ borderLeft: '5px solid var(--danger)' }}>
            <h3><PiWarning style={{ display: 'inline', verticalAlign: '-4px', color: 'var(--danger)' }} /> Файл не принят — ничего не изменено</h3>
            <ul className="tech-list small">
              {parsed.errors.slice(0, 30).map((e, i) => <li key={i}><code>{e.path}</code>: {e.message}</li>)}
            </ul>
            {parsed.errors.length > 30 && <p className="hint">И ещё {parsed.errors.length - 30} ошибок.</p>}
            <p className="hint">Попросите ChatGPT исправить файл строго по схеме из monthly_summary.md.</p>
          </div>
        )}

        {parsed?.ok && (
          <div className="card">
            <div className="card-head"><h2>Было → Станет</h2><span className="chip">{fileName}</span></div>
            <p className="mt0"><b>{parsed.title}</b></p>
            {parsed.summary && <p className="small muted">{parsed.summary}</p>}
            {parsed.warnings.map((w, i) => <Note key={i} kind="plain">{w}</Note>)}
            <div className="diff" style={{ marginTop: 10 }}>
              {parsed.changes.map((c) => {
                const on = !!sel[c.key];
                return (
                  <div key={c.key} className={`diff-change${c.danger ? ' danger' : ''}${on ? '' : ' off'}`}>
                    <label className="row nowrap" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={on} disabled={!c.applicable} onChange={(e) => setSel({ ...sel, [c.key]: e.target.checked })} style={{ width: 24, height: 24, marginTop: 2, flex: 'none' }} />
                      <span className="grow">
                        <span className="chip" style={{ marginRight: 6 }}>{CHANGE_TYPE_LABELS[c.type]}</span>
                        <b>{c.title}</b>
                        {c.effectiveFrom && <span className="muted small"> с {fmtFull(c.effectiveFrom)}</span>}
                        {c.reason && <span className="small" style={{ display: 'block', marginTop: 4 }}>Почему: {c.reason}</span>}
                      </span>
                    </label>
                    {c.lines.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {c.lines.slice(0, 60).map((l, i) => (
                          <div key={i} className={`diff-line${l.danger ? ' danger' : ''}`}>
                            <span className="lab">{l.label}</span><span className="was">{l.before}</span><span className="arr">→</span><span className="now">{l.after}</span>
                          </div>
                        ))}
                        {c.lines.length > 60 && <p className="hint">И ещё {c.lines.length - 60} строк.</p>}
                      </div>
                    )}
                    {c.warnings.map((w, i) => <p key={i} className="small" style={{ color: c.danger ? 'var(--danger)' : 'var(--ink-3)', margin: '6px 0 0' }}>{w}</p>)}
                    {!c.applicable && <p className="hint">Применять нечего.</p>}
                    {c.danger && on && (
                      <label className="row nowrap" style={{ marginTop: 8, color: 'var(--danger)', fontWeight: 600 }}>
                        <input type="checkbox" checked={!!risk[c.key]} onChange={(e) => setRisk({ ...risk, [c.key]: e.target.checked })} style={{ width: 22, height: 22, flex: 'none' }} />
                        Понимаю: нагрузка растёт резко. Применяю осознанно, при чистой технике и без боли.
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={apply}><PiCheck /> Применить выбранные ({Object.entries(sel).filter(([k, v]) => v && (!parsed.changes.find((c) => c.key === k)?.danger || risk[k])).length})</button>
              <button className="btn" onClick={() => { setParsed(null); toast('Обновление отклонено, план не изменён'); }}>Отклонить всё</button>
            </div>
            <p className="hint">Перед применением сохраняется снимок текущего плана — изменения можно откатить.</p>
          </div>
        )}
      </div>
      <div className="stack sticky-col">
        <Note kind="info" icon={<PiShieldCheck />}>
          <p>Файл — только данные. Код, HTML и ссылки внутри не выполняются: такой файл будет отклонён.</p>
          <p>Меняются только будущие плановые записи. Дни, где уже есть отметки, не перезаписываются.</p>
        </Note>
        {latest && (
          <div className="card">
            <h3>Последнее обновление</h3>
            <p className="mt0"><b>{latest.title}</b><br /><span className="small muted">{new Date(latest.importedAt).toLocaleString('ru-RU')}, изменений: {latest.applied.length}</span></p>
            <RollbackButton id={latest.id} />
          </div>
        )}
        <a className="btn ghost" href={href('/analysis', { tab: 'history' })}>История импортов</a>
      </div>
    </div>
  );
}

function RollbackButton({ id }: { id: string }) {
  const data = useApp();
  return (
    <button className="btn" onClick={async () => {
      if (!confirm('Откатить это обновление? План вернётся к состоянию до импорта. Отметки, вес и фото не изменятся.')) return;
      try {
        await commit(rollbackOps(data, id, nowStamp()));
        toast('Изменения откатаны');
      } catch (e: any) { toast(e?.message || 'Не удалось откатить'); }
    }}><PiArrowCounterClockwise /> Откатить изменения</button>
  );
}

// ------------------------------------------------------------------ резервная копия

function BackupSection() {
  const data = useApp();
  const [encrypt, setEncrypt] = useState(false);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState('');
  const [made, setMade] = useState<{ bytes: Uint8Array; name: string; summary: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [restoreFile, setRestoreFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [restorePw, setRestorePw] = useState('');
  const [parsedB, setParsedB] = useState<ParsedBackup | null>(null);
  const [restoreErr, setRestoreErr] = useState('');
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');

  const create = async () => {
    if (encrypt && (pw1.length < 6 || pw1 !== pw2)) { toast(pw1 !== pw2 ? 'Пароли не совпадают' : 'Пароль — не короче 6 символов'); return; }
    setBusy('Собираю данные…');
    setMade(null);
    try {
      const createdAt = new Date().toISOString();
      const blobs = await getAllPhotoBlobs();
      const { bytes, counts } = await buildBackupZip(data, blobs, __APP_VERSION__, createdAt);
      let out = bytes;
      if (encrypt) { setBusy('Шифрую…'); out = await encryptBytes(bytes, pw1); }
      setBusy('Проверяю восстановление…');
      const check = await readBackup(out, encrypt ? pw1 : undefined);
      const stamp = createdAt.slice(0, 16).replace('T', '_').replace(':', '');
      const name = `god-v-forme_backup_${stamp}${encrypt ? '.gvfenc' : '.zip'}`;
      const recs = Object.entries(check.counts).filter(([k]) => !['settings', 'meta', 'photoBlobs'].includes(k)).reduce((s, [, n]) => s + n, 0);
      setMade({ bytes: out, name, summary: `Проверено: ${recs} записей, фото ${check.photos.length} из ${counts.photos ?? 0}${encrypt ? ', зашифровано' : ''}.` });
      await A.updateSettings({ lastBackupAt: createdAt });
      await A.addExportRecord({ kind: 'backup', fileName: name, counts: check.counts, encrypted: encrypt, bytes: out.length });
    } catch (e: any) {
      toast(`Ошибка: ${e?.message || e}`);
    } finally {
      setBusy('');
    }
  };

  const pick = async (f?: File) => {
    if (!f) return;
    setParsedB(null); setRestoreErr(''); setRestorePw('');
    const bytes = await readFileBytes(f);
    setRestoreFile({ name: f.name, bytes });
    if (!isEncrypted(bytes)) await openBackup(bytes);
    if (fileRef.current) fileRef.current.value = '';
  };
  const openBackup = async (bytes: Uint8Array, pw?: string) => {
    try { setParsedB(await readBackup(bytes, pw)); setRestoreErr(''); } catch (e: any) { setRestoreErr(e?.message || String(e)); }
  };
  const doRestore = async () => {
    if (!parsedB) return;
    const warn = mode === 'replace'
      ? 'Все текущие данные на этом устройстве будут заменены данными из копии. Продолжить?'
      : 'Записи из копии будут добавлены к текущим (при совпадении остаётся более свежая). Продолжить?';
    if (!confirm(warn)) return;
    try {
      const ops = restoreOps(parsedB, mode, data, (store, rec) => rec[STORE_KEYS[store as keyof typeof STORE_KEYS]]);
      if (mode === 'replace') await replaceAll(ops);
      else await commit(ops);
      toast('Данные восстановлены');
      setParsedB(null); setRestoreFile(null);
      go('/today');
    } catch (e: any) { toast(`Не удалось восстановить: ${e?.message || e}`); }
  };

  return (
    <div className="cols">
      <div className="stack">
        <div className="card">
          <h2>Резервная копия всех данных</h2>
          <p className="muted mt0">Это не отчёт для ChatGPT: в копию входит всё — план, отметки, вес, фото, заметки, рецепты, история импортов и настройки. Нужна для переноса на iPhone/другой iPad и на случай очистки Safari.</p>
          <Note kind="warn" icon={<PiLock />}>В копии есть личные данные и фото тела. Храните файл в «Файлах» на устройстве или в своём облаке, не пересылайте посторонним. Для защиты включите пароль.</Note>
          <div style={{ marginTop: 10 }}>
            <Switch checked={encrypt} onChange={setEncrypt} label="Зашифровать паролем" hint="AES-256 на устройстве. Без пароля восстановить копию нельзя — запомните его." />
            {encrypt && (
              <div className="row nowrap">
                <label className="field grow"><span>Пароль</span><input className="input" type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} /></label>
                <label className="field grow"><span>Ещё раз</span><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
              </div>
            )}
          </div>
          <button className="btn primary big block" disabled={!!busy} onClick={create}><PiShieldCheck /> {busy || 'Создать резервную копию'}</button>
          {made && (
            <div style={{ marginTop: 14 }}>
              <Note kind="ok" icon={<PiCheck />}><b>{made.name}</b>, {fmtBytes(made.bytes.length)}. {made.summary}</Note>
              <button className="btn primary block" style={{ marginTop: 10 }} onClick={async () => { const r = await saveFile(made.bytes, made.name, made.name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'); if (r !== 'cancelled') toast('Копия сохранена'); }}><PiDownloadSimple /> Сохранить в «Файлы»</button>
            </div>
          )}
          <p className="hint">Последняя копия: {data.settings.lastBackupAt ? new Date(data.settings.lastBackupAt).toLocaleString('ru-RU') : 'ещё не создавалась'}.</p>
        </div>
      </div>
      <div className="stack">
        <div className="card">
          <h2>Восстановить из копии</h2>
          <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
          <button className="btn block" onClick={() => fileRef.current?.click()}><PiUploadSimple /> Выбрать файл копии</button>
          {restoreFile && isEncrypted(restoreFile.bytes) && !parsedB && (
            <div style={{ marginTop: 12 }}>
              <label className="field"><span>Пароль копии</span><input className="input" type="password" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') openBackup(restoreFile.bytes, restorePw); }} /></label>
              <button className="btn" onClick={() => openBackup(restoreFile.bytes, restorePw)}>Расшифровать</button>
            </div>
          )}
          {restoreErr && <p className="error-text">{restoreErr}</p>}
          {parsedB && (
            <div style={{ marginTop: 12 }}>
              <Note kind="ok" icon={<PiCheck />}>Целостность проверена. Копия от {new Date(parsedB.createdAt).toLocaleString('ru-RU')}, версия приложения {parsedB.appVersion}.</Note>
              <table className="table" style={{ marginTop: 8 }}><tbody>
                <tr><td>Дней плана</td><td className="n">{parsedB.counts.planDays ?? 0}</td></tr>
                <tr><td>Тренировок с отметками</td><td className="n">{parsedB.counts.trainingLogs ?? 0}</td></tr>
                <tr><td>Взвешиваний</td><td className="n">{parsedB.counts.weights ?? 0}</td></tr>
                <tr><td>Фото</td><td className="n">{parsedB.photos.length}</td></tr>
                <tr><td>Отметок задач</td><td className="n">{parsedB.counts.taskStatus ?? 0}</td></tr>
              </tbody></table>
              <div style={{ margin: '12px 0' }}>
                <Seg full value={mode} onChange={setMode} label="Способ" options={[{ value: 'replace', label: 'Заменить всё' }, { value: 'merge', label: 'Объединить' }]} />
              </div>
              <p className="hint">{mode === 'replace' ? 'Текущие данные на этом устройстве будут полностью заменены.' : 'Добавятся записи, которых нет; при совпадении остаётся более свежая версия. Настройки не меняются.'}</p>
              <button className={`btn block ${mode === 'replace' ? 'danger fill' : 'primary'}`} onClick={doRestore}>Восстановить</button>
            </div>
          )}
        </div>
        <Note kind="warn">Очистка данных Safari, удаление значка приложения или смена устройства может удалить локальную базу. Данные на iPad и iPhone не синхронизируются сами — переносите их резервной копией. Сохраняйте копию в «Файлы» регулярно, например после каждого взвешивания.</Note>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ история

function HistorySection() {
  const data = useApp();
  const exports = Object.values(data.exportHistory).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const patches = Object.values(data.patches).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  const latest = latestAppliedPatch(data);
  return (
    <div className="cols even">
      <div className="card">
        <h2>Импорт планов</h2>
        {patches.length === 0 ? <Empty title="Обновлений ещё не было">Загруженные plan_update.json появятся здесь с возможностью отката.</Empty> : (
          <div className="list">
            {patches.map((p) => (
              <div className="li" key={p.id} style={{ display: 'block' }}>
                <div className="row between">
                  <b>{p.title}</b>
                  <span className={`chip ${p.status === 'applied' ? 'accent' : ''}`}>{p.status === 'applied' ? 'применено' : 'откатано'}</span>
                </div>
                <div className="small muted">{new Date(p.importedAt).toLocaleString('ru-RU')}, {p.fileName}. Принято: {p.applied.length}, отклонено: {p.rejected.length}.</div>
                <Disclosure summary="Изменения">
                  {p.applied.map((c) => (
                    <div key={c.id} style={{ marginBottom: 8 }}>
                      <div className="small"><b>{c.title}</b>{c.effectiveFrom ? ` с ${fmtFull(c.effectiveFrom)}` : ''}</div>
                      {c.lines.slice(0, 12).map((l, i) => <div key={i} className="diff-line"><span className="lab">{l.label}</span><span className="was">{l.before}</span><span className="arr">→</span><span className="now">{l.after}</span></div>)}
                    </div>
                  ))}
                </Disclosure>
                {latest?.id === p.id && <RollbackButton id={p.id} />}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h2>Отчёты и копии</h2>
        {exports.length === 0 ? <Empty title="Выгрузок ещё не было" /> : (
          <div className="list">
            {exports.map((x) => (
              <div className="li" key={x.id}>
                <span className="grow">
                  <b>{x.kind === 'backup' ? 'Резервная копия' : 'Отчёт за месяц'}</b>
                  <span className="small muted" style={{ display: 'block' }}>{new Date(x.createdAt).toLocaleString('ru-RU')}{x.period ? `, ${fmtShort(x.period.from)}–${fmtShort(x.period.to)}` : ''}{x.includedPhotos ? `, фото: ${x.includedPhotos}` : ''}{x.encrypted ? ', с паролем' : ''}{x.bytes ? `, ${fmtBytes(x.bytes)}` : ''}</span>
                </span>
                <button className="icon-btn" aria-label="Удалить запись" onClick={() => A.deleteExportRecord(x.id)}>×</button>
              </div>
            ))}
          </div>
        )}
        <p className="hint">Сами файлы хранятся там, куда вы их сохранили; здесь — только журнал.</p>
      </div>
    </div>
  );
}
