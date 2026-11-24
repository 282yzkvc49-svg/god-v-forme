import { useEffect, useState, type ReactNode } from 'react';
import { useApp, useStorageStatus } from '../state/store';
import { useRoute, href, go } from './router';
import { menuUpdatePending } from '../domain/plan';
import { Toasts } from '../ui/kit';
import {
  KettlebellIcon, PiCalendarDots, PiBookOpen, PiCalendarBlank, PiChartLineUp, PiChatsCircle, PiCloudSlash, PiForkKnife, PiGear, PiHouse, PiShoppingCart, PiSquaresFour,
  PiWarning, PiArrowsClockwise,
} from '../ui/icons';
import { Today } from '../screens/Today';
import { CalendarScreen, DayPage } from '../screens/Calendar';
import { TrainingHub, ExercisePage } from '../screens/Training';
import { WorkoutScreen } from '../screens/Workout';
import { NutritionScreen, RecipesScreen, RecipePage, RecipeNeeded } from '../screens/Nutrition';
import { ShoppingHub, ShopPage, CookPage } from '../screens/Shopping';
import { ProgressScreen } from '../screens/Progress';
import { AnalysisScreen } from '../screens/Analysis';
import { SettingsScreen, MoreScreen } from '../screens/Settings';
import { TripsScreen } from '../screens/Trips';
import { MenuUpdateScreen } from '../screens/MenuUpdate';
import { TripUpdateScreen } from '../screens/TripUpdate';
import { CorrectionScreen } from '../screens/Correction';
import { correctionPending } from '../domain/correction';
import { today as todayFn } from '../lib/clock';
import { AvCheckScreen } from '../screens/AvCheck';
import { Onboarding } from '../screens/Onboarding';
import { WeekHub, WeekPage } from '../screens/Week';
import { LibraryScreen, LibRecipePage } from '../screens/Library';
import { onUpdateReady, applyUpdate } from './sw';

interface NavItem { path: string; label: string; icon: ReactNode; match: string[] }
const NAV: NavItem[] = [
  { path: '/today', label: 'Сегодня', icon: <PiHouse />, match: ['today'] },
  { path: '/calendar', label: 'Календарь', icon: <PiCalendarBlank />, match: ['calendar', 'day'] },
  { path: '/training', label: 'Тренировки', icon: <KettlebellIcon />, match: ['training', 'workout', 'exercise'] },
  { path: '/nutrition', label: 'Питание', icon: <PiForkKnife />, match: ['nutrition', 'recipes', 'recipe', 'recipe-needed'] },
  { path: '/week', label: 'Неделя: меню и закупка', icon: <PiCalendarDots />, match: ['week'] },
  { path: '/library', label: 'Библиотека рецептов', icon: <PiBookOpen />, match: ['library', 'lib'] },
  { path: '/shopping', label: 'Закупки и готовка', icon: <PiShoppingCart />, match: ['shopping', 'shop', 'cook', 'av-check', 'correction'] },
  { path: '/progress', label: 'Прогресс', icon: <PiChartLineUp />, match: ['progress'] },
  { path: '/analysis', label: 'Анализ с ChatGPT', icon: <PiChatsCircle />, match: ['analysis'] },
  { path: '/settings', label: 'Настройки', icon: <PiGear />, match: ['settings', 'trips', 'menu-update', 'trip-update'] },
];
const TABS = [NAV[0], NAV[1], NAV[2], NAV[3]];

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

function useTheme(theme: 'auto' | 'light' | 'dark') {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

let menuPromptShown = false;

export function App() {
  const data = useApp();
  const route = useRoute();
  const status = useStorageStatus();
  const online = useOnline();
  const [update, setUpdate] = useState(false);
  useTheme(data.settings.theme);
  useEffect(() => onUpdateReady(() => setUpdate(true)), []);
  // новое меню применено при запуске (или ждёт применения после отката): один раз показать отчёт о миграции
  useEffect(() => {
    if (!data.ready || menuPromptShown) return;
    const menu = !!(data.settings.menuReportUnseen || menuUpdatePending(data));
    // перенос командировки применён при запуске или ждёт подтверждения — один раз показать
    const trip = !!(data.settings.tripReportUnseen || data.settings.tripMovePending);
    // корректировка по фактическим покупкам ждёт проверки запасов и подтверждения
    const fact = !data.settings.weekly && !!(data.settings.correctionReportUnseen || correctionPending(data, todayFn()));
    const v2 = !!data.settings.weekly?.reportUnseen;
    if (!menu && !trip && !fact && !v2) return;
    menuPromptShown = true;
    if (!route.path[0] || route.path[0] === 'today') go(v2 ? '/week' : menu ? '/menu-update' : trip ? '/trip-update' : '/correction');
  }, [data.ready]);

  if (!data.ready) return <div className="boot">Загрузка…</div>;

  const top = route.path[0] || 'today';
  const isActive = (n: NavItem) => n.match.includes(top);
  const moreActive = !TABS.some(isActive);

  let screen: ReactNode;
  switch (top) {
    case 'today': screen = <Today />; break;
    case 'calendar': screen = <CalendarScreen />; break;
    case 'day': screen = <DayPage date={route.path[1]} />; break;
    case 'training': screen = <TrainingHub />; break;
    case 'workout': screen = <WorkoutScreen taskId={route.path[1]} />; break;
    case 'exercise': screen = <ExercisePage id={route.path[1]} />; break;
    case 'nutrition': screen = <NutritionScreen />; break;
    case 'recipes': screen = <RecipesScreen />; break;
    case 'recipe': screen = <RecipePage id={route.path[1]} />; break;
    case 'recipe-needed': screen = <RecipeNeeded />; break;
    case 'shopping': screen = <ShoppingHub />; break;
    case 'shop': screen = <ShopPage id={route.path[1]} />; break;
    case 'cook': screen = <CookPage id={route.path[1]} />; break;
    case 'progress': screen = <ProgressScreen />; break;
    case 'analysis': screen = <AnalysisScreen />; break;
    case 'settings': screen = <SettingsScreen />; break;
    case 'trips': screen = <TripsScreen />; break;
    case 'menu-update': screen = <MenuUpdateScreen />; break;
    case 'trip-update': screen = <TripUpdateScreen />; break;
    case 'correction': screen = <CorrectionScreen />; break;
    case 'av-check': screen = <AvCheckScreen />; break;
    case 'more': screen = <MoreScreen />; break;
    case 'week': screen = route.path[1] ? <WeekPage key={route.path[1]} id={route.path[1]} /> : <WeekHub />; break;
    case 'library': screen = <LibraryScreen />; break;
    case 'lib': screen = <LibRecipePage key={route.path[1]} id={route.path[1]} />; break;
    default: screen = <Today />;
  }

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Разделы">
        <div className="brand">Мой год в форме</div>
        <div className="brand-sub">{data.settings.goals.startWeightKg} → {data.settings.goals.targetWeightKg} кг</div>
        {NAV.map((n) => (
          <a key={n.path} href={href(n.path)} aria-current={isActive(n) ? 'page' : undefined}>{n.icon}{n.label}</a>
        ))}
        <div className="side-foot">
          {!online && <span className="row"><PiCloudSlash /> Без интернета — всё работает</span>}
          <span>Версия {__APP_VERSION__}</span>
        </div>
      </nav>
      <main className="main" id="main">
        {typeof __PREVIEW__ !== 'undefined' && __PREVIEW__ && (
          <div className="banner preview-banner"><PiWarning /><span className="grow"><b>Предварительный просмотр версии 2.0.</b> Отдельная копия: демо-данные плана на 22.11 и переход на 2.0 при открытии. Установленное приложение не меняется. Посмотреть на своих данных: в установленном приложении — «Анализ» → «Резервная копия» → сохранить, затем здесь <a href={href('/analysis', { tab: 'backup' })}>восстановить из файла</a>.</span></div>
        )}
        {status.mode === 'memory' && (
          <div className="banner warn"><PiWarning /><span className="grow">Хранилище браузера недоступно ({status.error}). Данные не сохранятся после закрытия — откройте приложение с экрана «Домой» в обычном режиме Safari.</span></div>
        )}
        {status.saveError && <div className="banner warn"><PiWarning /><span className="grow">{status.saveError}</span></div>}
        {update && (
          <div className="banner"><PiArrowsClockwise /><span className="grow">Доступна новая версия приложения. Данные сохранятся.</span><button className="btn small primary" onClick={applyUpdate}>Обновить</button></div>
        )}
        {screen}
      </main>
      <nav className="tabbar" aria-label="Разделы">
        {TABS.map((n) => (
          <a key={n.path} href={href(n.path)} aria-current={isActive(n) ? 'page' : undefined}>{n.icon}<span>{n.label}</span></a>
        ))}
        <a href={href('/more')} aria-current={moreActive ? 'page' : undefined}><PiSquaresFour /><span>Ещё</span></a>
      </nav>
      <Toasts />
      {!data.settings.onboarded && <Onboarding />}
    </div>
  );
}
