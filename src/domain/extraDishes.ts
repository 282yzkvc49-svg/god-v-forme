// Блюда, добавленные корректировкой по фактическим покупкам (22.11.2026): готовятся из того, что уже куплено.
// Граммовки — из согласованной корректировки на всю партию, здесь — на одну порцию.
// Оливковое масло — по желанию, если есть дома (в расчёт закупок и калорийности не входит).
import type { Dish } from './catalog';

export const EXTRA_DISHES: Dish[] = [
  {
    id: 'X01',
    title: 'Индейка с булгуром и овощами',
    short: 'Индейка с булгуром и овощами',
    category: 'dinner',
    kind: 'batch',
    unit: 'portion',
    unit_label: null,
    cooked_factor: null,
    serving_g: null,
    // партия на 3 порции: индейка 540 г, булгур 225 г, морковь 300 г, перец 240 г, лук 90 г
    ingredients: [
      { product: 'turkey', qty: 180, note: null },
      { product: 'bulgur', qty: 75, note: 'сухой' },
      { product: 'carrot', qty: 100, note: null },
      { product: 'pepper', qty: 80, note: 'красный' },
      { product: 'onion', qty: 30, note: null },
    ],
    spices: ['соль, специи — по вкусу', 'оливковое масло — до 8 мл на порцию (до 24 мл на партию), если есть дома'],
    steps: [
      { text: 'Индейку разморозить безопасно: в холодильнике (на ночь) или в пакете в холодной воде.', temperature_c: null, minutes: null },
      { text: 'Нарезать индейку, морковь, перец и лук.', temperature_c: null, minutes: null },
      { text: 'Булгур отварить (1 : 2 с водой, после закипания).', temperature_c: null, minutes: '12–15' },
      { text: 'Овощи потушить на сковороде, при желании с маслом.', temperature_c: null, minutes: '8–10' },
      { text: 'Индейку приготовить до полной готовности — на сковороде вместе с овощами или в аэрогриле при 190 °C.', temperature_c: '190', minutes: '12–15' },
      { text: 'Разделить на три одинаковые порции. Две порции быстро охладить и убрать в холодильник.', temperature_c: null, minutes: null },
    ],
    method: 'плита / аэрогриль',
    storage: { place: 'fridge', days: 3, freezable: true },
    note: 'Добавлено при корректировке 22.11 по фактическим покупкам.',
    legacy: null,
    active_minutes: 40,
    portable: true,
    storage_text: 'Остудить быстро, хранить в холодильнике не более 3 суток; на более поздние даты — заморозить',
    extra: true,
  },
  {
    id: 'X02',
    title: 'Куриное филе с рисом и брокколи',
    short: 'Куриное филе с рисом и брокколи',
    category: 'dinner',
    kind: 'batch',
    unit: 'portion',
    unit_label: null,
    cooked_factor: null,
    serving_g: null,
    // партия на 2 порции: курица 360 г, рис 140 г, брокколи 320 г
    ingredients: [
      { product: 'chicken', qty: 180, note: null },
      { product: 'rice', qty: 70, note: 'басмати, сухой' },
      { product: 'broccoli', qty: 160, note: 'замороженная' },
    ],
    spices: ['соль, специи — по вкусу', 'оливковое масло — до 10 мл на порцию (до 20 мл на партию), если есть дома'],
    steps: [
      { text: 'Курицу разморозить безопасно: в холодильнике (на ночь) или в пакете в холодной воде.', temperature_c: null, minutes: null },
      { text: 'Рис отварить.', temperature_c: null, minutes: '12–15' },
      { text: 'Курицу посолить и приготовить в аэрогриле или на электрогриле до полной готовности.', temperature_c: '190', minutes: '14–18' },
      { text: 'Брокколи приготовить на пару или отварить из замороженной 5–7 минут.', temperature_c: null, minutes: '5–7' },
      { text: 'Разделить на две порции; вторую быстро охладить и убрать в холодильник.', temperature_c: null, minutes: null },
    ],
    method: 'аэрогриль / электрогриль / плита',
    storage: { place: 'fridge', days: 3, freezable: true },
    note: 'Добавлено при корректировке 22.11 по фактическим покупкам.',
    legacy: null,
    active_minutes: 35,
    portable: true,
    storage_text: 'Остудить быстро, хранить в холодильнике не более 3 суток; на более поздние даты — заморозить',
    extra: true,
  },
];
