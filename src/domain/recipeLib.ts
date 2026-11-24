// Библиотека рецептов, встроенная в приложение (работает офлайн): src/data/library/*.json.
// Пищевая ценность считается по ингредиентам каталога; отметка «проверено» — только если отпечаток рецепта
// совпадает с отчётом автоматической проверки (npm run check:library), то есть рецепт не менялся после проверки.
import report from '../data/library/check_report.json';
import { LIB_RECIPES, PRODUCTS, libEff } from './catalog';
import { recipeHash, recipeNutrition, type LibRecipe, type RecipeNutr } from './recipeCheck';

export const LIBRARY: LibRecipe[] = LIB_RECIPES;
export const LIB_BY_ID: Record<string, LibRecipe> = Object.fromEntries(LIBRARY.map((r) => [r.id, r]));

interface ReportEntry { id: string; hash: string; ok: boolean; errors: string[]; warnings: string[] }
const REPORT: Record<string, ReportEntry> = Object.fromEntries(((report as { recipes?: ReportEntry[] }).recipes ?? []).map((e) => [e.id, e]));
export const REPORT_DATE: string | null = (report as { checkedAt?: string }).checkedAt ?? null;

export type VerifyState = 'verified' | 'failed' | 'unchecked';
/** Состояние проверки текущей редакции рецепта. */
export function verifyState(r: LibRecipe): VerifyState {
  const e = REPORT[r.id];
  if (!e || e.hash !== recipeHash(r)) return 'unchecked';
  return e.ok ? 'verified' : 'failed';
}
export function reportFor(id: string): ReportEntry | null { return REPORT[id] ?? null; }

const NUTR_CACHE = new Map<string, RecipeNutr>();
/** Ккал и БЖУ на порцию — по рецепту «как готовить сейчас» (с заменами товаров, которых нет на av.ru). */
export function libNutrition(r: LibRecipe): RecipeNutr {
  let n = NUTR_CACHE.get(r.id);
  if (!n) { n = recipeNutrition(libEff(r).r, PRODUCTS); NUTR_CACHE.set(r.id, n); }
  return n;
}

/** Короткие названия ингредиентов для рецептов (полное название товара — в закупках). */
const SHORT: Record<string, string> = {
  egg: 'Яйца', chickpeas: 'Нут консервированный', tomato: 'Помидоры', onion: 'Лук репчатый', oliveoil: 'Масло оливковое',
  paprika: 'Паприка копчёная', salt: 'Соль', bread: 'Хлеб цельнозерновой на закваске', curd: 'Творог 5%', cherry: 'Вишня замороженная',
  cinnamon: 'Корица', walnuts: 'Грецкие орехи', oats: 'Овсяные хлопья', almonds: 'Миндаль', beans: 'Фасоль красная консервированная',
  pepper: 'Перец сладкий красный', tuna: 'Тунец в собственном соку', cucumber: 'Огурцы', apple: 'Яблоко', carrot: 'Морковь', pear: 'Груша',
  chicken: 'Куриное филе (грудка)', rice: 'Рис басмати', tomatopuree: 'Томаты резаные в соку', garlic: 'Чеснок', lemon: 'Лимон', curry: 'Карри',
  buckwheat: 'Гречка', zucchini: 'Кабачок', broccoli: 'Брокколи замороженная', orange: 'Апельсин', turkey_mince: 'Фарш из филе индейки',
  bulgur: 'Булгур', turkey: 'Филе грудки индейки', beef_mince: 'Фарш говяжий', pollock: 'Минтай, филе', trout: 'Форель, стейк',
  yogurt: 'Йогурт натуральный 2%', pasta: 'Спагетти', lentils: 'Чечевица красная', potato: 'Картофель', mushroom: 'Шампиньоны',
  avocado: 'Авокадо', banana: 'Банан', kiwi: 'Киви', strawberry: 'Клубника замороженная', greenbeans: 'Фасоль стручковая замороженная',
  parmesan: 'Пармезан', l_greek_yogurt: 'Йогурт греческий 2% без сахара', l_soy_sauce: 'Соевый соус', l_pink_salmon: 'Горбуша, филе',
  l_hake: 'Хек, филе', l_shrimp: 'Креветки очищенные сырые', l_chicken_thigh: 'Филе куриного бедра', l_beef_lean: 'Говядина постная',
  l_crispbread: 'Хлебцы ржаные', l_bread_rye: 'Хлеб ржаной', l_lavash: 'Лаваш тонкий',
  l_pumpkin_seeds: 'Тыквенные семечки', l_mango_frozen: 'Манго замороженное', l_blueberry_frozen: 'Черника замороженная',
  l_spinach_frozen: 'Шпинат замороженный', l_peas_frozen: 'Горошек замороженный', l_greens: 'Зелень (укроп, петрушка)',
  l_olives: 'Оливки зелёные', l_cumin: 'Кумин (зира)', l_black_pepper: 'Перец чёрный молотый', l_tomato_paste: 'Томатная паста',
  l_flour_wg: 'Мука пшеничная', l_pork_tenderloin: 'Свиная вырезка', l_cabbage: 'Капуста белокочанная', l_ginger: 'Имбирь свежий',
  l_turkey_mince: 'Фарш из индейки', l_beef_mince: 'Фарш говяжий', l_trout: 'Форель, стейк', l_haddock: 'Пикша, филе',
  l_curd_cheese: 'Рикотта', l_cheese_light: 'Сыр лёгкий 15%',
};
export function ingrName(pid: string): string {
  return SHORT[pid] ?? (PRODUCTS[pid]?.name ?? pid).split(/[«,]/)[0].trim();
}
