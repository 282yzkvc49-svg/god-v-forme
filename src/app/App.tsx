import { useEffect, useState, type ReactNode } from 'react';
import { useApp, useStorageStatus } from '../state/store';
import { useRoute, href } from './router';
import { Toasts } from '../ui/kit';
import {
  KettlebellIcon, PiCalendarBlank, PiChartLineUp, PiChatsCircle, PiCloudSlash, PiForkKnife, PiGear, PiHouse, PiShoppingCart, PiSquaresFour,
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
import { Onboarding } from '../screens/Onboarding';
import { onUpdateReady, applyUpdate } from './sw';

interface NavItem { path: string; label: string; icon: ReactNode; match: string[] }
const NAV: NavItem[] = [
  { path: '/today', label: 'Сегодня', icon: <PiHouse />, match: ['today'] },
  { path: '/calendar', label: 'Календарь', icon: <PiCalendarBlank />, match: ['calendar', 'day'] },
  { path: '/training', label: 'Тренировки', icon: <KettlebellIcon />, match: ['training', 'workout', 'exercise'] },
  { path: '/nutrition', label: 'Питание', icon: <PiForkKnife />, match: ['nutrition', 'recipes', 'recipe', 'recipe-needed'] },
  { path: '/shopping', label: 'Закупки и готовка', icon: <PiShoppingCart />, match: ['shopping', 'shop', 'cook'] },
  { path: '/progress', label: 'Прогресс', icon: <PiChartLineUp />, match: ['progress'] },
  { path: '/analysis', label: 'Анализ с ChatGPT', icon: <PiChatsCircle />, match: ['analysis'] },
  { path: '/settings', label: 'Настройки', icon: <PiGear />, match: ['settings'] },
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

export function App() {
  const data = useApp();
  const route = useRoute();
  const status = useStorageStatus();
  const online = useOnline();
  const [update, setUpdate] = useState(false);
  useTheme(data.settings.theme);
  useEffect(() => onUpdateReady(() => setUpdate(true)), []);

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
    case 'more': screen = <MoreScreen />; break;
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
