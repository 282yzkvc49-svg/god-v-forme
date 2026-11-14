// Обновление меню как миграция: резервная копия, сводка замен товаров, удаление скумбрии из старых данных,
// что изменится в меню, готовках и закупках, проверки и отчёт. С версии 1.5.0 применяется при запуске
// автоматически (после внутренней резервной копии); вручную — только после отката.
import { useEffect, useMemo, useState } from 'react';
import { getAllPhotoBlobs, useApp } from '../state/store';
import * as A from '../state/actions';
import { useToday } from '../lib/clock';
import { BASE_PRODUCTS, DISHES, TEMPLATE } from '../domain/catalog';
import { BUDGET_RUB, KCAL_TARGET, dayNutrition, menuUpdatePending, planEnd } from '../domain/plan';
import { checkActiveData, checkInstance, checkSeedPlan, checkUserData, kcalSummary } from '../domain/planCheck';
import { applyOps, menuUpdateOps, storesToData } from '../state/model';
import { buildBackupZip } from '../domain/zipfiles';
import { saveFile } from '../lib/files';
import type { MigrationReport } from '../state/types';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { fmtDayMonth, fmtLong, fmtShort, localDate, weekdayShort, type ISODate } from '../lib/dates';
import { fmtRub } from '../lib/util';
import { href } from '../app/router';
import { Disclosure, Note, PageHead, toast } from '../ui/kit';
import { PiCheckBold, PiCookingPot, PiDownloadSimple, PiShoppingCart, PiSuitcase, PiWarning } from '../ui/icons';

export function MenuUpdateScreen() {
  const data = useApp();
  const today = useToday();
  const src = TEMPLATE.source;
  const pending = menuUpdatePending(data);
  const [date, setDate] = useState<ISODate>(pending ? TEMPLATE.base_start : data.settings.plan?.startDate ?? TEMPLATE.base_start);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const res = useMemo(() => (valid ? menuUpdateOps(data, date, today, new Date().toISOString(), __APP_VERSION__) : null), [date, today, data]);
  const inst = res?.instance ?? null;
  const checks = useMemo(() => (inst && res ? [...checkInstance(inst), ...checkSeedPlan(inst), checkActiveData(pending ? applyOps(data, res.ops) : data, today), ...checkUserData(data)] : []), [inst]);
  const lastBackup = Object.values(data.backups ?? {}).filter((b) => b.report).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const kcal = useMemo(() => (inst ? kcalSummary(inst) : null), [inst]);
  if (!res || !inst) {
    return (
      <div className="page narrow">
        <PageHead title="Новое меню" backTo="/today" />
        <label className="field"><span>Дата старта</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
    );
  }
  const cfg = inst.cfg;
  const end = planEnd(cfg);
  const cycle = inst.planDays.filter((d) => d.date >= cfg.startDate && d.date <= end);
  const homeDays = cycle.filter((d) => d.mealCards && !d.tripId);
  const changed = cycle.filter((d) => {
    if (d.date < today) return false;
    const old = data.planDays[d.date];
    return !old || JSON.stringify(old.meals) !== JSON.stringify(d.meals);
  }).length;
  const newIds = new Set([...inst.cookingEvents.map((e) => e.id), ...inst.shoppingEvents.map((e) => e.id)]);
  const removedCooks = Object.values(data.cookingEvents).filter((e) => e.source === 'seed' && e.date >= today && !newIds.has(e.id)).length;
  const removedShops = Object.values(data.shoppingEvents).filter((e) => e.source === 'seed' && e.date >= today && !newIds.has(e.id)).length;
  const conflicts = res.mealMarks > 0 || res.eventMarks.length > 0;
  const failed = checks.filter((c) => !c.ok);
  const recipes = TEMPLATE.dishes.filter((d) => !d.archived);
  const cnt = (c: string) => recipes.filter((d) => d.category === c).length;
  const seedTotal = src ? src.orders.reduce((s, o) => s + o.subtotal, 0) : 0;
  const homeShops = inst.shoppingEvents.filter((e) => e.kind !== 'trip');
  const tripShops = inst.shoppingEvents.filter((e) => e.kind === 'trip');
  const apply = () => {
    if (conflicts && !ack) return;
    setBusy(true);
    A.applyMenuUpdate(date).then(() => {
      toast(`Резервная копия создана, новое меню применено: старт ${fmtDayMonth(cfg.startDate)}`);
      window.scrollTo(0, 0);
    }).finally(() => setBusy(false));
  };
  const rep = res.report;

  return (
    <div className="page narrow">
      <PageHead title="Новое меню «Азбука вкуса»" sub={`${fmtDayMonth(cfg.startDate)} — ${fmtDayMonth(end)} · ${pending ? 'обновление базы — после резервной копии и вашего подтверждения' : 'меню применено'}`} backTo="/today" />
      {!pending && lastBackup?.report && <ReportCard report={lastBackup.report} backupId={lastBackup.id} createdAt={lastBackup.createdAt} />}
      {!pending && !lastBackup?.report && <Note kind="ok">Это меню уже применено. Здесь можно сверить проверки или выбрать другую дату старта.</Note>}

      {pending && (
        <div className="card">
          <h2>1. Резервная копия</h2>
          <p className="small mt0">Перед изменением базы приложение само сохранит внутреннюю копию всех данных (кроме фотографий — их обновление не трогает). Из неё можно вернуть прежнее меню одной кнопкой.</p>
          <p className="small">Рекомендуем ещё сохранить файл-копию в «Файлы» (с фото): {data.settings.lastBackupAt ? `последняя — ${fmtLong(data.settings.lastBackupAt.slice(0, 10))}.` : 'файловой копии ещё нет.'}</p>
          <a className="btn" href={href('/analysis', { tab: 'backup' })}>Сохранить копию в «Файлы»</a>
        </div>
      )}

      {pending && src?.audit && (
        <div className="card">
          <h2>2. Сводка замен</h2>
          <p className="small mt0">Меню и каталог заменяются целиком данными комплекта {TEMPLATE.id}; старые рецепты с новыми не смешиваются. Все {Object.values(BASE_PRODUCTS).filter((p) => !p.archived && p.url).length} товаров — индивидуальные карточки av.ru. Заменены карточки:</p>
          <table className="table small">
            <tbody>
              {src.audit.map((a) => (
                <tr key={a.id}>
                  <td>{a.name ?? BASE_PRODUCTS[a.id]?.name ?? a.id}</td>
                  <td>{a.note}{a.recipes.length ? ` — в рецептах ${a.recipes.join(', ')}` : ''}{a.old ? '' : ' (раньше — ссылка на подборку категории)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Скумбрия</h3>
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>В новом меню, рецептах, каталоге и закупках скумбрии нет.</li>
            <li>В будущих днях прежнего меню записей со скумбрией: {rep.mackerel.future} — заменятся новым меню.</li>
            <li>В прошедших данных без ваших отметок: {rep.mackerel.removedPast.length ? `${rep.mackerel.removedPast.length} — будут убраны` : 'нет'}.</li>
            <li>Отмеченное вами (съедено, куплено, приготовлено) остаётся историей: {rep.mackerel.keptHistory.length ? rep.mackerel.keptHistory.join('; ') : 'таких записей нет'}.</li>
            {rep.unknownRefsFixed.length > 0 && <li>Ссылки на удалённые товары в старых закупках: {rep.unknownRefsFixed.length} — будут убраны.</li>}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Что будет</h2>
        <label className="field" style={{ marginTop: 0 }}>
          <span>Старт меню (день 1)</span>
          <input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setAck(false); }} />
        </label>
        {date !== TEMPLATE.base_start && <Note kind="warn">В комплекте старт {fmtDayMonth(TEMPLATE.base_start)}. При другой дате меню идёт по домашним дням в том же порядке, а командировки и релакс-день остаются на своих датах.</Note>}
        <table className="table small">
          <tbody>
            <tr><td>Цикл</td><td>{fmtDayMonth(cfg.startDate)} — {fmtDayMonth(end)}: {homeDays.length} домашних дней, {cycle.filter((d) => d.tripId).length} командировочных, релакс-день {inst.layout.relaxDates.map(fmtShort).join(', ') || '—'}. Дальше — следующий цикл; годовой календарь не обрезается.</td></tr>
            <tr><td>Рецепты</td><td>{recipes.length}: завтраков {cnt('breakfast')} (каждый день разный), обедов {cnt('lunch')}, ужинов {cnt('dinner')}, перекусов {cnt('snack')} — с граммовками, шагами и товарами av.ru</td></tr>
            <tr><td>Готовка</td><td>{inst.cookingEvents.length} партий, {inst.cookingEvents.reduce((s, e) => s + (e.items ?? []).reduce((x, i) => x + i.qty, 0), 0)} порций обедов и ужинов</td></tr>
            <tr><td>Закупки</td><td>{homeShops.filter((e) => e.kind === 'main').length} основные (av.ru) и {homeShops.filter((e) => e.kind === 'topup').length} докупки свежего ≈{fmtRub(inst.totalCost)} при бюджете {fmtRub(BUDGET_RUB)}{src ? `; в комплекте — ${fmtRub(seedTotal)} без докупок` : ''}{inst.tripCost ? `; перекусы в поездки — отдельно ≈${fmtRub(inst.tripCost)}` : ''}</td></tr>
            {kcal && <tr><td>Калорийность</td><td>≈{kcal.avg} ккал в среднем ({kcal.min}–{kcal.max}) при ориентире {KCAL_TARGET} — расчётная, по справочным данным; вручную ничего вводить не нужно</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>{pending ? '3. Что изменится' : 'Что изменится при другой дате'}</h2>
        <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Меню на {changed} {changed === 1 ? 'день' : 'дн.'} с {fmtDayMonth(today > cfg.startDate ? today : cfg.startDate)} заменится новым; прошедшие дни останутся историей.</li>
          <li>Готовки и закупки прежнего меню на будущие даты ({removedCooks} готовок, {removedShops} закупок) заменятся новыми; выполненные — останутся в истории.</li>
          <li>Не меняются: тренировки (гири 12 и 16 кг, мини-степпер, техника, журнал), вес, фото, месячные отчёты, импорт корректировок, командировки и релакс-день.</li>
          {rep.keptMarks.length > 0 && <li>Ваши отметки на днях, где меняется блюдо, сохраняются: {rep.keptMarks.join('; ')}.</li>}
        </ul>
        {conflicts && (
          <Note kind="warn">
            <p>На сегодня и будущие дни уже есть отметки прежнего плана: {res.mealMarks ? `приёмов пищи — в ${res.mealMarks} дн.` : ''}{res.eventMarks.length ? ` ${res.eventMarks.join(', ')}` : ''}. Отметки не удаляются: они останутся на своих датах и в истории.</p>
            <label className="row nowrap" style={{ gap: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Понятно, применить новое меню</label>
          </Note>
        )}
        <Disclosure summary={<><PiCookingPot /> Готовки ({inst.cookingEvents.length})</>}>
          <div className="list">
            {inst.cookingEvents.map((e) => (
              <div className="li" key={e.id} style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{weekdayShort(e.date)} {fmtShort(e.date)}, {e.time}</div>
                  <div className="small">{(e.items ?? []).map((i) => `${DISHES[i.dishId].title} ×${i.qty} → ${i.uses.map((u) => `${fmtShort(u.date)} ${MEAL_LABELS[u.slot].toLowerCase()}${u.storage === 'freeze' ? ' (заморозить)' : ''}`).join(', ')}`).join('; ')}</div>
                  {e.timeNote && <div className="small muted">{e.timeNote}</div>}
                </div>
              </div>
            ))}
          </div>
        </Disclosure>
        <Disclosure summary={<><PiShoppingCart /> Закупки ({homeShops.length}{tripShops.length ? ` + ${tripShops.length} в поездки` : ''})</>}>
          <div className="list">
            {[...homeShops, ...tripShops].map((e) => (
              <div className="li" key={e.id} style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{e.kind === 'trip' && <PiSuitcase />} {e.title}: {weekdayShort(e.date)} {fmtShort(e.date)}{e.time ? `, ${e.time}` : ''}</div>
                  <div className="small muted">{(e.lines ?? []).filter((l) => l.buy > 0).length} позиций, ≈{fmtRub((e.lines ?? []).reduce((s, l) => s + l.cost, 0))}{e.forDatesText ? ` · для ${e.forDatesText}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </Disclosure>
        <Disclosure summary="Меню по дням">
          <div className="list">
            {cycle.map((d) => (
              <div className="li" key={d.date} style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 64, fontWeight: 600 }}>{weekdayShort(d.date)} {fmtShort(d.date)}</div>
                <div className="grow small">
                  {d.mealCards ? MEAL_SLOTS.map((s) => <div key={s}>{MEAL_LABELS[s]}: {d.mealCards![s].title}</div>)
                    : d.tripId ? <span>Командировка: {data.trips[d.tripId]?.city} — гибкое меню, завтрак в гостинице</span>
                      : <span>Релакс-день: свободная еда без подсчёта, без алкоголя</span>}
                  {d.mealCards && <div className="muted">≈{Math.round((dayNutrition(d)?.kcal ?? 0) / 10) * 10} ккал (расчёт)</div>}
                </div>
              </div>
            ))}
          </div>
        </Disclosure>
      </div>

      <div className="card">
        <div className="card-head"><h2>Проверки</h2><span className={`chip ${failed.length ? 'warn' : 'accent'}`}>{failed.length ? `замечаний: ${failed.length}` : 'всё сходится'}</span></div>
        <div className="list">
          {checks.map((c) => (
            <div className="li" key={`${c.id}-${c.title}`} style={{ alignItems: 'flex-start' }}>
              <span style={{ color: c.ok ? 'var(--accent)' : 'var(--warn)', marginTop: 2 }}>{c.ok ? <PiCheckBold /> : <PiWarning />}</span>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                {c.details.slice(0, 4).map((x, i) => <div key={i} className="small muted">{x}</div>)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Что не проверено</h2>
        <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Цены — опубликованные на av.ru на 14.11.2026. Это не собранная корзина: итог, наличие и доставка в Лосино-Петровский станут известны только после выбора адреса и оформления заказа. После применения — «Проверить на av.ru»: откройте каждый товар, отметьте, есть ли он в вашей корзине; недоступный заблокируется в закупке до подтверждённой замены.</li>
          <li>{src ? src.orders.length : 2} основные закупки рассчитаны на две недели вперёд, но скоропортящееся (молочное, грибы, огурцы, помидоры, бананы, авокадо) столько не хранится — поэтому есть небольшие докупки: {homeShops.filter((e) => e.kind === 'topup').map((e) => fmtShort(e.date)).join(', ')}. Часть можно заменить замороженным.</li>
          <li>Калорийность — расчётная по справочным значениям комплекта, а не по этикеткам av.ru.</li>
          {inst.cookingEvents.some((e) => e.time === '07:00') && <li>В {inst.cookingEvents.filter((e) => e.time === '07:00').map((e) => fmtShort(e.date)).join(', ')} обед — из партии того же дня, поэтому готовка утром до работы (так в комплекте).</li>}
        </ul>
      </div>

      <div className="btn-row" style={{ marginBottom: 24 }}>
        <button className="btn primary big" disabled={busy || (conflicts && !ack)} onClick={apply}><PiCheckBold /> {pending ? 'Создать резервную копию и применить' : 'Применить с этой датой'}</button>
        <a className="btn big" href={href(pending ? '/today' : '/av-check')}>{pending ? 'Позже' : 'Проверить товары на av.ru'}</a>
      </div>
    </div>
  );
}

function ReportCard({ report, backupId, createdAt }: { report: MigrationReport; backupId: string; createdAt: string }) {
  const data = useApp();
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  useEffect(() => { A.markMenuReportSeen(); }, []);
  const md = report.mackerelDates;
  const dates = (xs: string[]) => xs.map(fmtShort).join(', ');
  const prepare = async () => {
    const b = data.backups?.[backupId];
    if (!b) return;
    setBusy(true);
    try {
      const { bytes } = await buildBackupZip(storesToData(b.stores), await getAllPhotoBlobs(), b.appVersion, b.createdAt);
      setFile({ bytes, name: `god-v-forme_backup_do-obnovleniya_${b.createdAt.slice(0, 16).replace('T', '_').replace(':', '')}.zip` });
    } catch (e: any) {
      toast(`Ошибка: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Отчёт о миграции</h2>
      {report.auto && (
        <Note kind="ok">
          <p className="mt0">Новое меню применено автоматически при запуске{data.backups?.[backupId]?.appVersion ? ` версии ${data.backups[backupId].appVersion}` : ''}. До этого в базе на этом устройстве оставалось {data.backups?.[backupId]?.fromMenu ? `меню «${data.backups[backupId].fromMenu}»` : 'прежнее меню, собранное до перехода на «Азбуку вкуса»'}: новое меню ждало кнопки «Применить», поэтому прежнее продолжало показываться и попадало в экспорт.</p>
          {md && (md.days.length + md.cooks.length + md.shops.length > 0) && <p style={{ marginBottom: 0 }}>Скумбрия была в прежнем меню: {md.days.length ? `дни ${dates(md.days)}` : ''}{md.cooks.length ? `; готовки ${dates(md.cooks)}` : ''}{md.shops.length ? `; закупки ${dates(md.shops)}` : ''}. Эти записи заменены новым меню.</p>}
        </Note>
      )}
      <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
        <li>Резервная копия: {fmtLong(localDate(new Date(createdAt)))}, {new Date(createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} (внутренняя, все данные кроме фото).</li>
        <li>Старт меню: {fmtLong(report.startDate)}; дней с новым меню: {report.replacedDays}; заменено будущих готовок прежнего меню: {report.removedFutureCooks}, закупок: {report.removedFutureShops}.</li>
        <li>Скумбрия: в будущих данных — {report.mackerel.future} записей заменено новым меню; в прошедших без отметок убрано — {report.mackerel.removedPast.length}; осталось историей (отмечено вами) — {report.mackerel.keptHistory.length}.</li>
        {report.mackerel.keptHistory.map((x, i) => <li key={i} className="muted">{x}</li>)}
        {report.unknownRefsFixed.length > 0 && <li>Ссылки на удалённые товары убраны: {report.unknownRefsFixed.length}.</li>}
        {report.keptMarks.length > 0 && <li>Отметки на днях со сменой блюда сохранены: {report.keptMarks.length}.</li>}
        <li>Тренировки, вес, фото, отметки, командировки и релакс-день — без изменений.</li>
      </ul>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <a className="btn primary" href={href('/av-check')}>Проверить товары на av.ru</a>
        {file
          ? <button className="btn" onClick={async () => { const r = await saveFile(file.bytes, file.name, 'application/zip'); if (r !== 'cancelled') toast('Копия сохранена'); }}><PiDownloadSimple /> Сохранить в «Файлы»</button>
          : <button className="btn" disabled={busy || !data.backups?.[backupId]} onClick={prepare}>Файл копии до обновления</button>}
        <button className="btn ghost" disabled={busy} onClick={() => { if (!confirm('Вернуть прежнее меню из резервной копии? Отметки, вес, фото и тренировки останутся.')) return; setBusy(true); A.rollbackMenuUpdate(backupId).then(() => toast('Прежнее меню восстановлено из копии')).finally(() => setBusy(false)); }}>Вернуть прежнее меню</button>
      </div>
    </div>
  );
}

