import { useEffect, useState, type ReactNode } from 'react';
import { useApp, useStorageStatus, wipeEverything } from '../state/store';
import * as A from '../state/actions';
import { useToday, isTodayOverridden } from '../lib/clock';
import { href, useRoute } from '../app/router';
import { fmtDayMonth, fmtFull, isISODate, isTime, WEEKDAYS_FULL } from '../lib/dates';
import { fmtBytes } from '../lib/util';
import { PLAN_END, PLAN_START, SEED_ID } from '../lib/seed';
import { MEAL_LABELS, MEAL_SLOTS } from '../state/types';
import { isStandalone } from '../lib/files';
import { NumberStepper, Note, PageHead, Seg, Switch, toast } from '../ui/kit';
import {
  PiBookOpen, PiChartLineUp, PiChatsCircle, PiGear, PiShoppingCart, PiTrash, PiCaretRight, PiShareNetwork,
} from '../ui/icons';

function Group({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section className="card" id={id} style={{ scrollMarginTop: 20 }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field" style={{ marginBottom: 8 }}>
      <span>{label}</span>
      <input className="input" type="time" value={isTime(value) ? value : ''} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  );
}

export function SettingsScreen() {
  const data = useApp();
  const today = useToday();
  const route = useRoute();
  const status = useStorageStatus();
  const s = data.settings;
  const [est, setEst] = useState<{ usage?: number; quota?: number } | null>(null);
  const [delFrom, setDelFrom] = useState('');
  const [delTo, setDelTo] = useState('');
  useEffect(() => { navigator.storage?.estimate?.().then(setEst).catch(() => {}); }, [data]);
  useEffect(() => {
    const sec = route.query.get('s');
    if (sec) setTimeout(() => document.getElementById(sec)?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [route.raw]);
  const dinner = s.mealTimes.dinner;
  return (
    <div className="page narrow">
      <PageHead title="Настройки" />
      <div className="stack">
        <Group id="start" title="Начало силовых">
          <label className="field">
            <span>Начать силовые тренировки с</span>
            <div className="row nowrap">
              <input className="input" type="date" value={s.trainingStartDate ?? ''} min={PLAN_START} onChange={(e) => A.updateSettings({ trainingStartDate: isISODate(e.target.value) ? e.target.value : null })} />
              {s.trainingStartDate && <button className="btn" onClick={() => A.updateSettings({ trainingStartDate: null })}>По плану</button>}
            </div>
            <span className="hint">{s.trainingStartDate ? `Силовые до ${fmtDayMonth(s.trainingStartDate)} показываются как «отложено» и не считаются пропусками.` : 'Сейчас — по плану, с первого дня.'}</span>
          </label>
          <Switch checked={s.postponeCardio} onChange={(v) => A.updateSettings({ postponeCardio: v })} label="Откладывать и степпер" hint="Степпер тоже начнётся с выбранной даты" />
        </Group>

        <Group title="Цели">
          <div className="row" style={{ gap: 24 }}>
            <div className="field"><span className="field-label">Стартовый вес</span><NumberStepper label="Стартовый вес" value={s.goals.startWeightKg} step={0.5} min={40} max={300} unit="кг" onChange={(v) => v != null && A.updateSettings({ goals: { ...s.goals, startWeightKg: v } })} /></div>
            <div className="field"><span className="field-label">Цель</span><NumberStepper label="Целевой вес" value={s.goals.targetWeightKg} step={0.5} min={40} max={300} unit="кг" onChange={(v) => v != null && A.updateSettings({ goals: { ...s.goals, targetWeightKg: v } })} /></div>
          </div>
          <p className="hint">Ориентир энергии: ≈{s.goals.kcalReference} ккал/сутки — оценочный стартовый ориентир, не проверенная калорийность блюд. Калории и БЖУ в приложении не ведутся.</p>
        </Group>

        <Group title="Расписание">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            {MEAL_SLOTS.filter((m) => m !== 'dinner').map((m) => (
              <div key={m} style={{ width: 130 }}><TimeField label={MEAL_LABELS[m]} value={s.mealTimes[m]} onChange={(v) => A.updateSettings({ mealTimes: { ...s.mealTimes, [m]: v } })} /></div>
            ))}
            <label className="field" style={{ width: 170 }}>
              <span>Ужин</span>
              <input className="input" value={dinner} onChange={(e) => A.updateSettings({ mealTimes: { ...s.mealTimes, dinner: e.target.value } })} />
            </label>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div style={{ width: 170 }}><TimeField label="Тренировка в будни" value={s.trainingTimeWeekday} onChange={(v) => A.updateSettings({ trainingTimeWeekday: v })} /></div>
            <div style={{ width: 170 }}><TimeField label="Тренировка в выходные" value={s.trainingTimeWeekend} onChange={(v) => A.updateSettings({ trainingTimeWeekend: v })} /></div>
          </div>
          <Switch checked={s.containersEnabled} onChange={(v) => A.updateSettings({ containersEnabled: v })} label="Вечером: «Подготовить контейнеры на завтра»" hint="Перед рабочими днями" />
          <label className="field">
            <span>Первый день план-месяца (для отчётов и статистики)</span>
            <select className="input" value={s.monthStartDay} onChange={(e) => A.updateSettings({ monthStartDay: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}-е число</option>)}
            </select>
          </label>
        </Group>

        <Group title="Взвешивание и фото">
          <Switch checked={s.weighIn.enabled} onChange={(v) => A.updateSettings({ weighIn: { ...s.weighIn, enabled: v } })} label="Напоминать о взвешивании" />
          {s.weighIn.enabled && (
            <div className="row nowrap">
              <label className="field grow"><span>День недели</span>
                <select className="input" value={s.weighIn.weekday} onChange={(e) => A.updateSettings({ weighIn: { ...s.weighIn, weekday: Number(e.target.value) } })}>
                  {WEEKDAYS_FULL.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}
                </select>
              </label>
              <div style={{ width: 140 }}><TimeField label="Время" value={s.weighIn.time} onChange={(v) => A.updateSettings({ weighIn: { ...s.weighIn, time: v } })} /></div>
            </div>
          )}
          <Switch checked={s.photo.enabled} onChange={(v) => A.updateSettings({ photo: { ...s.photo, enabled: v } })} label="Напоминать о фото прогресса" hint="Раз в месяц" />
          {s.photo.enabled && (
            <label className="field"><span>Число месяца</span>
              <select className="input" value={s.photo.dayOfMonth} onChange={(e) => A.updateSettings({ photo: { ...s.photo, dayOfMonth: Number(e.target.value) } })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}-е</option>)}
              </select>
            </label>
          )}
          <div className="field">
            <span className="field-label">Размер сохраняемых фото</span>
            <Seg value={s.photoMaxSide} onChange={(v) => A.updateSettings({ photoMaxSide: v })} label="Размер фото" options={[
              { value: 1200, label: '1200 px' }, { value: 1600, label: '1600 px' }, { value: 2048, label: '2048 px' }, { value: 0, label: 'Оригинал' },
            ]} />
            <span className="hint">Меньше размер — меньше места; 1600 px достаточно для сравнения «до/после».</span>
          </div>
          <Switch checked={s.showWaist} onChange={(v) => A.updateSettings({ showWaist: v })} label="Показывать обхват талии" hint="Необязательная метрика" />
        </Group>

        <Group title="Таймер отдыха">
          <div className="field">
            <span className="field-label">По умолчанию</span>
            <Seg value={s.restDefaultSec} onChange={(v) => A.updateSettings({ restDefaultSec: v })} label="Отдых" options={[60, 75, 90].map((v) => ({ value: v, label: `${v} сек` }))} />
          </div>
          <Switch checked={s.restAutoStart} onChange={(v) => A.updateSettings({ restAutoStart: v })} label="Запускать после отметки подхода" />
          <Switch checked={s.restSound} onChange={(v) => A.updateSettings({ restSound: v })} label="Звуковой сигнал" hint="Звучит, если не включён беззвучный режим" />
        </Group>

        <Group title="Внешний вид">
          <Seg value={s.theme} onChange={(v) => A.updateSettings({ theme: v })} label="Тема" options={[{ value: 'auto', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]} />
        </Group>

        <Group id="data" title="Данные и приватность">
          <p className="mt0 small">Все данные хранятся только на этом устройстве (IndexedDB). Аккаунтов, аналитики и отправки в интернет нет.</p>
          <div className="btn-row">
            <a className="btn primary" href={href('/analysis', { tab: 'backup' })}>Резервная копия и восстановление</a>
          </div>
          <p className="hint">
            {status.mode === 'idb' ? 'Хранилище работает.' : status.mode === 'memory' ? 'Хранилище недоступно — данные не сохраняются!' : ''}
            {status.persisted === true ? ' Система пометила данные как постоянные.' : status.persisted === false ? ' Система может очистить данные при нехватке места — делайте резервные копии.' : ''}
            {est?.usage != null ? ` Занято: ${fmtBytes(est.usage)}.` : ''}
          </p>
          <hr className="divider" />
          <h3>Удаление</h3>
          <div className="btn-row">
            <button className="btn danger" onClick={() => { const n = Object.keys(data.photos).length; if (!n) { toast('Фото нет'); return; } if (confirm(`Удалить все фото (${n})? Отменить нельзя.`)) { A.deleteAllPhotos(); toast('Фото удалены'); } }}><PiTrash /> Удалить все фото</button>
          </div>
          <div className="row nowrap" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <label className="field grow" style={{ margin: 0 }}><span>Данные с</span><input className="input" type="date" value={delFrom} onChange={(e) => setDelFrom(e.target.value)} /></label>
            <label className="field grow" style={{ margin: 0 }}><span>по</span><input className="input" type="date" value={delTo} onChange={(e) => setDelTo(e.target.value)} /></label>
            <button className="btn danger" disabled={!isISODate(delFrom) || !isISODate(delTo) || delFrom > delTo} onClick={async () => {
              if (!confirm(`Удалить отметки, вес, фото, заметки и тренировки за ${fmtFull(delFrom)} — ${fmtFull(delTo)}? План и рецепты останутся.`)) return;
              const n = await A.deleteDataForPeriod(delFrom, delTo);
              toast(`Удалено записей: ${n}`);
            }}>Удалить</button>
          </div>
          <p className="hint">Удаляются только ваши записи за период; план, рецепты и история импортов остаются.</p>
          <button className="btn danger fill" style={{ marginTop: 8 }} onClick={async () => {
            if (!confirm('Удалить ВСЕ данные приложения на этом устройстве: отметки, вес, фото, историю? Сначала сделайте резервную копию.')) return;
            if (!confirm('Точно удалить всё? Действие необратимо.')) return;
            await wipeEverything();
            location.reload();
          }}><PiTrash /> Удалить все локальные данные</button>
        </Group>

        <Group id="install" title="Установка на iPad и iPhone">
          <p className="mt0">{isStandalone() ? 'Приложение открыто с экрана «Домой» — всё в порядке.' : 'Сейчас приложение открыто во вкладке браузера.'}</p>
          <ol className="tech-list small">
            <li>Откройте адрес приложения в Safari.</li>
            <li>Нажмите «Поделиться» <PiShareNetwork style={{ display: 'inline', verticalAlign: '-3px' }} /> → «На экран „Домой“». Если есть переключатель «Открывать как веб-приложение» — оставьте его включённым.</li>
            <li>Запускайте с иконки «Год в форме». После первой загрузки работает без интернета.</li>
            <li>Данные вкладки Safari и установленного приложения раздельные: ведите записи в установленном.</li>
            <li>Чтобы перенести данные на iPhone — резервная копия → «Файлы» → восстановить на другом устройстве.</li>
          </ol>
          {s.installHintDismissed && <button className="btn small" onClick={() => A.updateSettings({ installHintDismissed: false })}>Снова показывать подсказку на главной</button>}
        </Group>

        <Group title="О приложении">
          <table className="table"><tbody>
            <tr><td>Версия</td><td className="n">{__APP_VERSION__} ({__BUILD_ID__})</td></tr>
            <tr><td>Стартовый план</td><td className="n">{fmtFull(PLAN_START)} — {fmtFull(PLAN_END)}</td></tr>
            <tr><td>Набор данных</td><td className="n">{SEED_ID}</td></tr>
            <tr><td>Дней плана загружено</td><td className="n">{Object.keys(data.planDays).length}</td></tr>
            <tr><td>Установлено</td><td className="n">{data.meta ? fmtFull(data.meta.installDate) : '—'}</td></tr>
          </tbody></table>
          {isTodayOverridden() && <Note kind="warn">Включён тестовый режим даты: «сегодня» = {fmtFull(today)}. Откройте адрес с ?today=off, чтобы выключить.</Note>}
          <p className="hint">Источники: «План_питания_2ноя_1дек_2026.xlsx», «Рецепты_к_меню_ноябрь_2026.docx», ТЗ v1.0. Меню и рецепты перенесены дословно; схемы упражнений нарисованы для приложения.</p>
        </Group>
      </div>
    </div>
  );
}

export function MoreScreen() {
  const items = [
    { to: '/shopping', label: 'Закупки и готовка', icon: <PiShoppingCart /> },
    { to: '/progress', label: 'Прогресс', icon: <PiChartLineUp /> },
    { to: '/analysis', label: 'Анализ с ChatGPT', icon: <PiChatsCircle /> },
    { to: '/recipes', label: 'Рецепты', icon: <PiBookOpen /> },
    { to: '/settings', label: 'Настройки', icon: <PiGear /> },
  ];
  return (
    <div className="page narrow">
      <PageHead title="Ещё" />
      <div className="card tight">
        <div className="list">
          {items.map((i) => (
            <a key={i.to} className="li" href={href(i.to)} style={{ padding: '6px 8px', fontWeight: 600, fontSize: 17 }}>
              <span className="task-icon">{i.icon}</span><span className="grow">{i.label}</span><PiCaretRight />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
