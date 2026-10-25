#!/usr/bin/env python3
"""
Сборка src/data/initial_seed.json из исходных файлов пользователя.

Источники:
  * План_питания_2ноя_1дек_2026.xlsx — календарь 30 дней, закупки, готовка, рецепты, памятка;
  * Рецепты_к_меню_ноябрь_2026.docx — тот же набор из 28 рецептов (сверяется с таблицей);
  * ТЗ v1.0, раздел 5 — шаблоны «Силовая А», «Силовая Б», «Степпер», дни восстановления.

Запуск:  python3 tools/build_seed.py путь/к/План.xlsx [путь/к/Рецепты.docx]
Скрипт ничего не придумывает в меню: блюда и рецепты переносятся дословно.
Справочник упражнений и словарь соответствий «блюдо → рецепт» описаны ниже явно,
чтобы их можно было проверить глазами.
"""
import datetime as dt
import json
import re
import sys
import zipfile
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "initial_seed.json"
YEAR = 2026

# ----------------------------------------------------------------------------
# Рецепты: id ↔ точное название из источника
# ----------------------------------------------------------------------------
RECIPE_IDS = {
    "Курица лимон-паприка": "chicken_lemon_paprika",
    "Чили из индейки": "turkey_chili",
    "Тефтели из индейки": "turkey_meatballs",
    "Говядина гриль": "beef_grill",
    "Курица терияки без сахара": "chicken_teriyaki",
    "Куриные котлеты": "chicken_cutlets",
    "Индейка с горчицей": "turkey_mustard",
    "Куриное бедро без кожи": "chicken_thigh",
    "Курица чеснок-йогурт": "chicken_garlic_yogurt",
    "Скумбрия": "mackerel",
    "Хек": "hake",
    "Форель": "trout",
    "Лосось/сёмга": "salmon",
    "Креветки с чесноком": "shrimp_garlic",
    "Индейка томатная": "turkey_tomato",
    "Курица с нутом и рисом": "chicken_chickpea_rice",
    "Крупы: рис, гречка, булгур, кускус": "grains",
    "Картофель в аэрогриле": "potato_airfryer",
    "Ночная овсянка": "overnight_oats",
    "Лаваш с индейкой": "lavash_turkey",
    "Творожная тарелка": "cottage_plate",
    "Омлет в лаваше": "omelet_lavash",
    "Яичные бутерброды": "egg_sandwich",
    "Сырники в аэрогриле": "syrniki",
    "Овсяные панкейки": "oat_pancakes",
    "Йогурт с ягодами и гранолой": "yogurt_berries_granola",
    "Творог + фрукт + орехи": "cottage_fruit_nuts",
    "Хумус с хлебцами": "hummus_crispbread",
}
RECIPE_TYPES = {"Основное": "main", "Гарнир": "side", "Завтрак": "breakfast", "Перекус": "snack"}
FISH = {"mackerel", "hake", "trout", "salmon", "shrimp_garlic"}

# ----------------------------------------------------------------------------
# Справка по хранению — только формулировки из источников
# ----------------------------------------------------------------------------
STORAGE_GUIDE = [
    {"id": "cool_fast", "text": "Готовую пищу быстро остужай и убирай в холодильник. Ориентир для большинства готовых блюд — 3–4 дня при холодном хранении; что не съешь вовремя — заморозь.", "source": "Рецепты, «Как готовить дважды в неделю»"},
    {"id": "meat_3_4", "text": "Остывшие блюда — в холодильник; готовое мясо и гарниры использовать за 3–4 дня или сразу заморозить.", "source": "Таблица, «Памятка» → Хранение"},
    {"id": "freeze", "text": "Заморозь большую часть мяса, рыбы и лишние порции уже приготовленных блюд. Размораживай в холодильнике, не на столе.", "source": "Рецепты, «Как готовить дважды в неделю»"},
    {"id": "fish_thaw", "text": "Рыбу размораживать в холодильнике; рыбу из морозилки размораживать отдельно.", "source": "Таблица, «Памятка» и «Готовка» 08.11"},
    {"id": "veg_separate", "text": "Овощи и салат хранить отдельно от горячего блюда: в отдельном контейнере, без разогрева.", "source": "Таблица, «Готовка» 22.11 — «Овощи хранить отдельно»"},
    {"id": "reheat", "text": "Разогревать до горячего состояния.", "source": "Таблица, «Готовка» 04.11"},
    {"id": "portion", "text": "Порционно остудить; хранить до 3 дней; лишнее — в морозилку.", "source": "Таблица, «Готовка» 01.11"},
    {"id": "work_fridge", "text": "Еда на работе: холодильник + микроволновка.", "source": "Таблица, «Меню 30 дней» → Примечание"},
]

# ----------------------------------------------------------------------------
# Упражнения (ТЗ, раздел 5). Техника — стандартные безопасные формулировки.
# ----------------------------------------------------------------------------
EXERCISES = [
    {
        "id": "warmup_stepper", "name": "Разминка на мини-степпере", "equipment": ["Мини-степпер"],
        "kind": "cardio", "figure": "stepper", "muscles": "Разогрев ног и сердца перед силовой частью",
        "frames": ["Правая педаль внизу, левая вверху", "Шаг: педали меняются местами"],
        "steps": [
            "Встаньте на педали всей стопой, ноги на ширине таза.",
            "Корпус ровный, взгляд вперёд, плечи расслаблены.",
            "Шагайте в спокойном темпе, помогая себе руками.",
            "Дышите свободно; к концу 5 минут станет тепло, но не тяжело.",
        ],
        "mistakes": ["Шаги на носках с отрывом пяток от педалей", "Сильный наклон вперёд", "Слишком быстрый темп на разминке"],
        "easier": "Медленный темп; для равновесия можно касаться рукой стены.",
        "warnings": ["Головокружение, боль в груди или резкая одышка — остановитесь."],
    },
    {
        "id": "goblet_squat", "name": "Присед с гирей у груди", "equipment": ["Гиря"],
        "kind": "reps", "figure": "goblet_squat", "muscles": "Бёдра, ягодицы, мышцы корпуса",
        "frames": ["Исходное: стоя, гиря у груди", "Ключевое: присед с ровной спиной"],
        "steps": [
            "Стопы чуть шире плеч, носки слегка развёрнуты наружу.",
            "Держите гирю двумя руками за дужку у груди, локти смотрят вниз.",
            "Вдох — отведите таз назад и вниз, колени идут по линии носков.",
            "Опуститесь до комфортной глубины, сохраняя ровную спину и пятки на полу.",
            "Выдох — встаньте, отталкиваясь всей стопой.",
        ],
        "mistakes": ["Колени заваливаются внутрь", "Пятки отрываются от пола", "Округление поясницы внизу", "Гиря отходит от груди"],
        "easier": "Присед без гири или до касания стула; меньшая глубина.",
        "warnings": ["Вес увеличивайте только при чистой технике.", "Боль в колене или спине — прекратите подход."],
    },
    {
        "id": "kb_row", "name": "Тяга гири к поясу одной рукой", "equipment": ["Гиря"],
        "kind": "reps", "per_side": "руку", "figure": "kb_row", "muscles": "Спина, задняя дельта, бицепс",
        "frames": ["Исходное: наклон, рука с гирей прямая", "Ключевое: локоть отведён назад, гиря у пояса"],
        "steps": [
            "Шагните одной ногой вперёд, колени слегка согнуты; свободную руку положите на бедро впереди стоящей ноги.",
            "Наклонитесь из тазобедренных суставов с ровной спиной; гиря в другой руке висит под плечом.",
            "Выдох — тяните гирю к поясу, ведя локоть назад вдоль корпуса.",
            "Вверху сведите лопатку, не разворачивая корпус.",
            "Вдох — плавно опустите гирю до прямой руки. Выполните повторы и смените сторону.",
        ],
        "mistakes": ["Скругление спины", "Рывок корпусом вместо работы руки", "Плечо поднимается к уху", "Разворот корпуса вслед за гирей"],
        "easier": "Меньший вес и меньший наклон корпуса.",
        "warnings": ["Ставьте гирю на пол, сгибая ноги, а не спину."],
    },
    {
        "id": "push_up", "name": "Отжимания", "equipment": ["Собственный вес"],
        "kind": "reps", "figure": "push_up", "muscles": "Грудь, трицепс, передняя дельта, корпус",
        "frames": ["Исходное: упор лёжа на прямых руках", "Ключевое: грудь у пола, тело прямое"],
        "steps": [
            "Ладони чуть шире плеч, пальцы смотрят вперёд.",
            "Тело — прямая линия от головы до пяток; напрягите пресс и ягодицы.",
            "Вдох — сгибайте локти и опускайте грудь к полу; локти примерно под 30–45° к корпусу.",
            "Выдох — выжмите себя вверх, сохраняя прямую линию тела.",
        ],
        "mistakes": ["Провисание поясницы", "Таз поднят вверх", "Локти разведены в стороны под 90°", "Голова опущена к полу"],
        "easier": "Отжимания от стены или от края устойчивого стола; отжимания с колен.",
        "warnings": ["При боли в запястьях — уменьшите наклон (отжимания от опоры повыше)."],
    },
    {
        "id": "glute_bridge", "name": "Ягодичный мостик", "equipment": ["Собственный вес"],
        "kind": "reps", "figure": "glute_bridge", "muscles": "Ягодицы, задняя поверхность бедра",
        "frames": ["Исходное: лёжа, колени согнуты", "Ключевое: таз поднят, плечи–таз–колени на одной линии"],
        "steps": [
            "Лягте на спину, колени согнуты, стопы на ширине таза на полу.",
            "Руки лежат вдоль корпуса ладонями вниз.",
            "Выдох — поднимите таз, сжимая ягодицы, до прямой линии плечи–таз–колени.",
            "Задержитесь на 1–2 секунды наверху.",
            "Вдох — плавно опустите таз на пол.",
        ],
        "mistakes": ["Прогиб в пояснице наверху", "Толчок носками вместо пяток", "Колени разъезжаются или сводятся"],
        "easier": "Меньшая амплитуда подъёма.",
        "warnings": ["Шея расслаблена, голову не поднимать."],
    },
    {
        "id": "plank", "name": "Планка на предплечьях", "equipment": ["Собственный вес"],
        "kind": "time", "figure": "plank", "muscles": "Пресс, мышцы корпуса, плечи",
        "frames": ["Исходное: упор на предплечья и колени", "Ключевое: тело — прямая линия, удержание"],
        "steps": [
            "Встаньте на колени, поставьте локти под плечи, предплечья параллельно.",
            "Отведите ноги назад и встаньте на носки.",
            "Тело — прямая линия от головы до пяток; напрягите пресс и ягодицы.",
            "Дышите ровно и держите положение заданное время.",
        ],
        "mistakes": ["Провисание поясницы", "Таз слишком высоко", "Задержка дыхания", "Голова опущена"],
        "easier": "Планка с опорой на колени.",
        "warnings": ["Не задерживайте дыхание."],
    },
    {
        "id": "kb_rdl", "name": "Румынская тяга с гирей", "equipment": ["Гиря"],
        "kind": "reps", "figure": "kb_rdl", "muscles": "Задняя поверхность бедра, ягодицы, разгибатели спины",
        "frames": ["Исходное: стоя, гиря у бёдер", "Ключевое: наклон с ровной спиной, таз отведён назад"],
        "steps": [
            "Стопы на ширине таза, гиря в обеих руках перед бёдрами.",
            "Колени слегка согнуты и почти не меняют угол во время движения.",
            "Вдох — отводите таз назад и наклоняйте корпус с ровной спиной; гиря скользит близко к ногам.",
            "Опуститесь до ощущения натяжения задней поверхности бедра (обычно гиря на уровне колен или середины голени).",
            "Выдох — вернитесь в стойку, толкая таз вперёд; наверху не прогибайтесь назад.",
        ],
        "mistakes": ["Скругление спины", "Присед вместо наклона", "Гиря уходит далеко от ног", "Переразгибание поясницы наверху"],
        "easier": "Без гири или с меньшим весом; меньшая амплитуда.",
        "warnings": ["Боль в пояснице — прекратите подход и уменьшите вес."],
    },
    {
        "id": "kb_floor_press", "name": "Жим гири лёжа на полу", "equipment": ["Гиря"],
        "kind": "reps", "per_side": "руку", "figure": "kb_floor_press", "muscles": "Грудь, трицепс, передняя дельта",
        "frames": ["Исходное: плечо и локоть на полу, гиря над запястьем", "Ключевое: рука выпрямлена над плечом"],
        "steps": [
            "Лягте на спину, колени согнуты, стопы на полу.",
            "Возьмите гирю, перекатившись на бок, двумя руками; затем вернитесь на спину.",
            "Локоть на полу примерно под 45° к корпусу, предплечье вертикально, запястье прямое.",
            "Выдох — выжмите гирю вверх над плечом до прямой руки.",
            "Вдох — медленно опустите до мягкого касания локтем пола. После подхода смените руку.",
        ],
        "mistakes": ["Локоть разведён под 90°", "Запястье заломлено назад", "Удар локтем о пол", "Гиря уходит к лицу"],
        "easier": "Меньший вес; жим одной гири двумя руками.",
        "warnings": ["Брать и класть гирю — только перекатом на бок, не над лицом."],
    },
    {
        "id": "reverse_lunge", "name": "Выпады назад", "equipment": ["Собственный вес"],
        "kind": "reps", "per_side": "ногу", "figure": "reverse_lunge", "muscles": "Бёдра, ягодицы, баланс",
        "frames": ["Исходное: стоя прямо", "Ключевое: шаг назад, колено задней ноги у пола"],
        "steps": [
            "Встаньте прямо, руки на поясе, стопы на ширине таза.",
            "Сделайте шаг назад одной ногой, сохраняя ширину колеи.",
            "Опустите колено задней ноги к полу, не ударяя им; переднее колено над стопой.",
            "Корпус вертикально; оттолкнитесь передней ногой и вернитесь в стойку.",
            "Сделайте повторы на одну ногу, затем на другую.",
        ],
        "mistakes": ["Переднее колено заваливается внутрь", "Стопы на одной линии — теряется равновесие", "Удар коленом о пол", "Наклон корпуса вперёд"],
        "easier": "Держитесь рукой за стену или спинку стула; меньшая глубина.",
        "warnings": ["Боль в колене — уменьшите глубину или прекратите."],
    },
    {
        "id": "side_plank", "name": "Боковая планка", "equipment": ["Собственный вес"],
        "kind": "time", "per_side": "сторону", "figure": "side_plank", "muscles": "Косые мышцы живота, корпус, плечо",
        "frames": ["Исходное: лёжа на боку, локоть под плечом", "Ключевое: таз поднят, тело — прямая линия"],
        "steps": [
            "Лягте на бок, локоть точно под плечом, ноги вместе.",
            "Верхнюю руку положите на пояс.",
            "Поднимите таз до прямой линии от головы до стоп.",
            "Держите положение, дыхание ровное; затем смените сторону.",
        ],
        "mistakes": ["Таз провисает", "Локоть не под плечом", "Корпус заваливается вперёд или назад"],
        "easier": "С опорой на колени (ноги согнуты).",
        "warnings": ["Боль в плече — прекратите."],
    },
    {
        "id": "stepper_cardio", "name": "Мини-степпер", "equipment": ["Мини-степпер"],
        "kind": "cardio", "figure": "stepper", "muscles": "Выносливость, ноги",
        "frames": ["Правая педаль внизу", "Шаг: педали меняются местами"],
        "steps": [
            "Встаньте на педали всей стопой, корпус ровный.",
            "Первые 2–3 минуты — спокойный темп.",
            "Далее умеренный темп: дыхание учащено, но можно говорить фразами.",
            "Последние 2 минуты — замедлитесь.",
        ],
        "mistakes": ["Шаги на носках", "Сильный наклон вперёд", "Слишком высокий темп с первых минут"],
        "easier": "Делите время на отрезки по 5 минут с короткими паузами.",
        "warnings": ["Головокружение, боль в груди или резкая одышка — остановитесь."],
    },
    {
        "id": "walk", "name": "Прогулка", "equipment": [],
        "kind": "cardio", "figure": "walk", "muscles": "Восстановление",
        "frames": ["Шаг", "Следующий шаг"],
        "steps": [
            "Прогулка в комфортном темпе по самочувствию.",
            "Дыхание спокойное, без одышки.",
        ],
        "mistakes": ["Превращать день восстановления в тяжёлую тренировку"],
        "easier": "Короче и медленнее — тоже засчитывается.",
        "warnings": [],
    },
]

TEMPLATES = [
    {
        "id": "strength_a", "name": "Силовая А", "type": "strength", "duration_min": [25, 30], "rest_sec": [60, 90],
        "description": "Стартовая силовая тренировка на всё тело: степпер, гиря и собственный вес.",
        "items": [
            {"exercise_id": "warmup_stepper", "sets": 1, "minutes": 5, "note": "Разминка"},
            {"exercise_id": "goblet_squat", "sets": 2, "reps": 8, "weight_kg": [12, 16]},
            {"exercise_id": "kb_row", "sets": 2, "reps": 8, "per_side": "руку", "weight_kg": [8, 12]},
            {"exercise_id": "push_up", "sets": 2, "reps": 8},
            {"exercise_id": "glute_bridge", "sets": 2, "reps": 12},
            {"exercise_id": "plank", "sets": 2, "seconds": 20},
        ],
    },
    {
        "id": "strength_b", "name": "Силовая Б", "type": "strength", "duration_min": [25, 30], "rest_sec": [60, 90],
        "description": "Вторая силовая тренировка: наклон, жим, выпады и боковая планка.",
        "items": [
            {"exercise_id": "warmup_stepper", "sets": 1, "minutes": 5, "note": "Разминка"},
            {"exercise_id": "kb_rdl", "sets": 2, "reps": 10, "weight_kg": [12, 16]},
            {"exercise_id": "kb_floor_press", "sets": 2, "reps": 8, "per_side": "руку", "weight_kg": [6, 10]},
            {"exercise_id": "reverse_lunge", "sets": 2, "reps": 6, "per_side": "ногу", "note": "Без гири"},
            {"exercise_id": "kb_row", "sets": 2, "reps": 10, "per_side": "руку", "weight_kg": [8, 12], "weight_note": "Ориентир как в Силовой А"},
            {"exercise_id": "side_plank", "sets": 2, "seconds": 20, "per_side": "сторону"},
        ],
    },
    {
        "id": "stepper", "name": "Степпер", "type": "cardio", "duration_min": [15, 20], "rest_sec": None,
        "description": "Кардио на мини-степпере умеренным темпом.",
        "items": [{"exercise_id": "stepper_cardio", "sets": 1, "minutes": [15, 20]}],
    },
    {
        "id": "recovery", "name": "Восстановление", "type": "recovery", "duration_min": None, "rest_sec": None,
        "description": "Восстановление / прогулка — без силовой нагрузки.",
        "items": [{"exercise_id": "walk", "sets": 1, "note": "По самочувствию"}],
    },
]
TRAINING_LABELS = {
    "Силовая А": "strength_a",
    "Силовая Б": "strength_b",
    "Степпер 15–20 мин": "stepper",
    "Восстановление / прогулка": "recovery",
    "Релакс-день / отдых": "rest",
}

# ----------------------------------------------------------------------------
# Словарь «название в меню → рецепт». kind:
#   exact   — название совпадает с рецептом;
#   alias   — то же блюдо в другом варианте (рецепт допускает замену фрукта/топпинга);
#   similar — точного рецепта нет, есть похожий для ориентира → «Нужно уточнить рецепт»;
#   simple  — собрать из готовых продуктов, отдельный рецепт не нужен;
#   unknown — рецепта нет → «Нужно уточнить рецепт».
# ----------------------------------------------------------------------------
COMPONENTS = {
    # основные блюда обедов/ужинов
    "курица лимон-паприка": ("exact", "chicken_lemon_paprika", None),
    "чили из индейки": ("exact", "turkey_chili", None),
    "тефтели из индейки": ("exact", "turkey_meatballs", None),
    "говядина гриль": ("exact", "beef_grill", None),
    "курица терияки": ("alias", "chicken_teriyaki", "Рецепт «Курица терияки без сахара»"),
    "лосось": ("alias", "salmon", "Рецепт «Лосось/сёмга»"),
    "куриные котлеты": ("exact", "chicken_cutlets", None),
    "форель": ("exact", "trout", None),
    "индейка горчица": ("alias", "turkey_mustard", "Рецепт «Индейка с горчицей»"),
    "индейка с горчицей": ("exact", "turkey_mustard", None),
    "куриное бедро": ("alias", "chicken_thigh", "Рецепт «Куриное бедро без кожи»"),
    "куриное бедро без кожи": ("exact", "chicken_thigh", None),
    "курица чеснок-йогурт": ("exact", "chicken_garlic_yogurt", None),
    "скумбрия": ("exact", "mackerel", None),
    "хек": ("exact", "hake", None),
    "курица паприка": ("alias", "chicken_lemon_paprika", "В меню «Курица паприка»; ближайший рецепт — «Курица лимон-паприка». Проверьте, тот ли это вариант."),
    "индейка томатная": ("exact", "turkey_tomato", None),
    "креветки с чесноком": ("exact", "shrimp_garlic", None),
    # гарниры
    "рис": ("alias", "grains", "Рецепт «Крупы: рис, гречка, булгур, кускус»"),
    "гречка": ("alias", "grains", "Рецепт «Крупы: рис, гречка, булгур, кускус»"),
    "булгур": ("alias", "grains", "Рецепт «Крупы: рис, гречка, булгур, кускус»"),
    "кускус": ("alias", "grains", "Рецепт «Крупы: рис, гречка, булгур, кускус»"),
    "киноа": ("similar", "grains", "Киноа нет в рецепте круп — время варки уточнить по упаковке."),
    "перловка": ("similar", "grains", "Перловки нет в рецепте круп — время варки уточнить по упаковке."),
    "картофель": ("alias", "potato_airfryer", "Рецепт «Картофель в аэрогриле»"),
    # овощи — отдельный рецепт не нужен
    "брокколи": ("simple", None, "Овощной гарнир (замороженная брокколи)"),
    "перец": ("simple", None, "Свежий сладкий перец"),
    "овощи": ("simple", None, "Овощной гарнир"),
    "салат": ("simple", None, "Листовой салат и свежие овощи"),
    "большой овощной салат": ("simple", None, "Листовой салат и свежие овощи"),
    "кабачок": ("simple", None, "Овощной гарнир"),
    "морковь": ("simple", None, "Овощной гарнир"),
    "стручковая фасоль": ("simple", None, "Замороженная стручковая фасоль"),
    "капуста": ("simple", None, "Свежая капуста"),
    "огурец": ("simple", None, "Свежий огурец"),
    "томаты": ("simple", None, "Свежие томаты"),
    "шпинат": ("simple", None, "Замороженный шпинат"),
    "свёкла": ("unknown", None, "Свёклы нет ни в рецептах, ни в списке закупок — уточнить."),
}

WHOLE = {
    # завтраки
    "овсянка на ночь: йогурт, банан, лён, грецкий орех": ("alias", "overnight_oats", None),
    "лаваш с индейкой, мягким сыром и томатом": ("alias", "lavash_turkey", None),
    "творог с яблоком, корицей, орехами и хлебцами": ("alias", "cottage_plate", "Фрукт — яблоко"),
    "греческий йогурт с ягодами, гранолой и чиа": ("alias", "yogurt_berries_granola", None),
    "бутерброд с яйцом, сыром и огурцом": ("alias", "egg_sandwich", None),
    "омлет со шпинатом, цельнозерновой тост": ("similar", "omelet_lavash", "Точного рецепта нет; похожий — «Омлет в лаваше»."),
    "сырники из творога в аэрогриле с ягодами": ("alias", "syrniki", None),
    "гречка с молоком, грушей и миндалём": ("similar", "grains", "Точного рецепта нет; крупа — по рецепту «Крупы»."),
    "лаваш с курицей, листьями салата и йогуртовым соусом": ("similar", "lavash_turkey", "Точного рецепта нет; похожий — «Лаваш с индейкой»."),
    "творожный десерт с киви, бананом и семечками": ("alias", "cottage_plate", "Фрукт — киви и банан"),
    "йогурт с овсяными хлопьями, яблоком и орехами": ("similar", "overnight_oats", "Точного рецепта нет; похожий — «Ночная овсянка»."),
    "ржаные тосты с тунцом, огурцом и яйцом": ("similar", "egg_sandwich", "Точного рецепта нет; похожий — «Яичные бутерброды»."),
    "омлет в лаваше с сыром": ("alias", "omelet_lavash", None),
    "овсяные панкейки с ягодами и творогом": ("alias", "oat_pancakes", None),
    "творог с грушей, какао и орехами": ("alias", "cottage_plate", "Фрукт — груша"),
    "цельнозерновой сэндвич с индейкой и шпинатом": ("similar", "lavash_turkey", "Точного рецепта нет; похожий — «Лаваш с индейкой»."),
    "ночная овсянка с замороженной вишней и семенами": ("alias", "overnight_oats", None),
    "салат из яиц, фасоли и томатов с хлебом": ("unknown", None, None),
    "йогурт с манго (замороженным), мюсли и миндалём": ("similar", "yogurt_berries_granola", "Точного рецепта нет; похожий — «Йогурт с ягодами и гранолой». Манго нет в списке закупок."),
    "яичный скрэмбл с грибами и тостом": ("unknown", None, None),
    "творожные оладьи без сахара на гриле": ("similar", "syrniki", "Точного рецепта нет; похожий — «Сырники в аэрогриле»."),
    "лаваш с нежирным сыром, огурцом и курицей": ("similar", "lavash_turkey", "Точного рецепта нет; похожий — «Лаваш с индейкой»."),
    "творог с апельсином, семенами тыквы и овсянкой": ("alias", "cottage_plate", "Фрукт — апельсин"),
    "сэндвич с куриными котлетами и томатами": ("similar", "chicken_cutlets", "Сборка из готовых котлет; отдельного рецепта сэндвича нет."),
    "кефирно-овсяный смузи с бананом, орехами и тостом": ("unknown", None, None),
    "йогурт с черникой, семенами и домашней гранолой": ("alias", "yogurt_berries_granola", None),
    "горячий сэндвич на гриле с яйцом и индейкой": ("similar", "egg_sandwich", "Точного рецепта нет; похожий — «Яичные бутерброды»."),
    "творог с ягодами, бананом и миндалём": ("alias", "cottage_plate", "Фрукт — ягоды и банан"),
    "рулет из лаваша с яйцом, сыром и зеленью": ("similar", "omelet_lavash", "Точного рецепта нет; похожий — «Омлет в лаваше»."),
    # перекусы
    "йогурт 200 г + ягоды 100 г + орехи 25 г + банан": ("simple", None, "Собрать в контейнер"),
    "творог 200 г + яблоко + хлебцы": ("alias", "cottage_fruit_nuts", None),
    "кефир 300 мл + банан + миндаль 25 г + тост": ("simple", None, "Собрать в контейнер"),
    "йогурт 220 г + киви + семечки 25 г + тост": ("simple", None, "Собрать в контейнер"),
    "творог 180 г + груша + грецкие орехи 25 г": ("alias", "cottage_fruit_nuts", None),
    "хумус 80 г + хлебцы + огурец + кефир": ("alias", "hummus_crispbread", None),
    "запечённое яблоко + йогурт 200 г + орехи": ("unknown", None, "Нет рецепта запечённого яблока."),
    "сэндвич с индейкой 90 г и огурцом": ("similar", "lavash_turkey", "Точного рецепта нет; похожий — «Лаваш с индейкой»."),
    "ряженка 300 мл + банан + семечки": ("simple", None, "Собрать в контейнер"),
    "творожный крем 200 г + ягоды + тост": ("simple", None, "Собрать в контейнер"),
    "йогурт 200 г + гранола 50 г + груша": ("simple", None, "Собрать в контейнер"),
    "лаваш-ролл с сыром, зеленью и томатом": ("similar", "lavash_turkey", "Точного рецепта нет; похожий — «Лаваш с индейкой»."),
    "хлебцы + хумус + яйцо + помидор": ("similar", "hummus_crispbread", "Точного рецепта нет; похожий — «Хумус с хлебцами»."),
    "йогурт 200 г + ягоды + чиа + банан": ("simple", None, "Собрать в контейнер"),
    "кефир 300 мл + орехи 25 г + фрукт": ("simple", None, "Собрать в контейнер"),
}

# Готовка: блюда по каждой дате (текст источника + явная привязка к рецептам)
COOK_DISHES = {
    "01.11": [("Курица лимон-паприка", ["chicken_lemon_paprika"]), ("Чили из индейки", ["turkey_chili"]), ("Рис, гречка", ["grains"]), ("Брокколи", [])],
    "04.11": [("Тефтели индейки", ["turkey_meatballs"]), ("Постная говядина", ["beef_grill"]), ("Булгур", ["grains"]), ("Морковь, кабачок", [])],
    "08.11": [("Курица терияки", ["chicken_teriyaki"]), ("Куриные котлеты", ["chicken_cutlets"]), ("Рис, гречка", ["grains"]), ("Фасоль", [])],
    "11.11": [("Форель", ["trout"]), ("Индейка с горчицей", ["turkey_mustard"]), ("Кускус", ["grains"]), ("Овощи", [])],
    "15.11": [("Куриные бёдра", ["chicken_thigh"]), ("Курица чеснок-йогурт", ["chicken_garlic_yogurt"]), ("Перловка", []), ("Картофель", ["potato_airfryer"]), ("Капуста", [])],
    "18.11": [("Тефтели индейки", ["turkey_meatballs"]), ("Хек", ["hake"]), ("Булгур", ["grains"]), ("Брокколи, морковь", [])],
    "22.11": [("Курица паприка", ["chicken_lemon_paprika"]), ("Форель/лосось", ["trout", "salmon"]), ("Гречка", ["grains"]), ("Фасоль", [])],
    "25.11": [("Индейка томатная", ["turkey_tomato"]), ("Куриные котлеты", ["chicken_cutlets"]), ("Рис", ["grains"]), ("Шпинат", [])],
    "28.11": [("Куриные котлеты", ["chicken_cutlets"]), ("Булгур", ["grains"]), ("Овощи", [])],
}
COOK_NOTES = {
    "Перловка": "Перловки нет в рецепте круп — уточнить время варки по упаковке.",
}

SHOP_CATEGORY_ORDER = ["Белок", "Рыба", "Морепродукты", "Консервы", "Молочные", "Бобовые", "Крупы", "Завтраки", "Овощи", "Фрукты", "Ягоды", "Орехи", "Прочее"]

WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]

# Строки памятки и примечания закупок, которые по решению пользователя не переносятся в приложение.
EXCLUDED_MEMO = {"Здоровье"}
NOTE_DROPPED_FOR = {"Апельсины"}


def norm(s: str) -> str:
    s = s.strip().lower().replace("ё", "е")
    s = re.sub(r"\s*\(дома\)\s*$", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def ddmm_to_iso(s: str) -> str:
    d, m = s.split(".")[:2]
    return f"{YEAR}-{int(m):02d}-{int(d):02d}"


def parse_for_dates(text: str):
    m = re.search(r"(\d{2})(?:\.(\d{2}))?[–-](\d{2})\.(\d{2})", text)
    if not m:
        return []
    d1, m1, d2, m2 = m.group(1), m.group(2) or m.group(4), m.group(3), m.group(4)
    start = dt.date(YEAR, int(m1), int(d1))
    end = dt.date(YEAR, int(m2), int(d2))
    out = []
    cur = start
    while cur <= end:
        out.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return out


NUM = r"(\d+(?:[.,]\d+)?)"
RANGE = NUM + r"(?:\s*[–-]\s*" + NUM + r")?"
UNITS = r"(г|кг|мл|л|ч\.л\.?|ст\.л\.?)"
COUNT_WORDS = {
    "яйцо": ("шт.", "яйцо"), "яйца": ("шт.", "яйца"), "луковица": ("шт.", "луковица"),
    "зубчик чеснока": ("зубч.", "чеснок"), "банки фасоли": ("банки", "фасоль"),
}


def to_num(x):
    if x is None:
        return None
    v = float(x.replace(",", "."))
    return int(v) if v.is_integer() else v


def parse_ingredient(piece: str):
    p = piece.strip().rstrip(".")
    # «600 г грудки», «180–200 г рыбы»
    m = re.match(r"^" + RANGE + r"\s*" + UNITS + r"\s+(.+)$", p)
    if m:
        return {"source_text": p, "qty": to_num(m.group(1)), "qty_max": to_num(m.group(2)), "unit": m.group(3), "name": m.group(4)}
    # «паприка 1 ч.л.», «Овсянка 55 г», «рис 180 г сухого», «чеснок 1–2 зубчика»
    m = re.match(r"^(.+?)\s+" + RANGE + r"\s*" + UNITS + r"(?:\s+(.+))?$", p)
    if m:
        name = m.group(1) + (f" ({m.group(5)})" if m.group(5) else "")
        unit = {"ч.л": "ч.л.", "ст.л": "ст.л."}.get(m.group(4), m.group(4))
        return {"source_text": piece.strip(), "qty": to_num(m.group(2)), "qty_max": to_num(m.group(3)), "unit": unit, "name": name}
    m = re.match(r"^(.+?)\s+" + RANGE + r"\s+(зубчика|зубчиков)$", p)
    if m:
        return {"source_text": p, "qty": to_num(m.group(2)), "qty_max": to_num(m.group(3)), "unit": "зубч.", "name": m.group(1)}
    # «1 яйцо», «2 банки фасоли», «1 зубчик чеснока»
    m = re.match(r"^(\d+)\s+(.+)$", p)
    if m and m.group(2) in COUNT_WORDS:
        unit, name = COUNT_WORDS[m.group(2)]
        return {"source_text": p, "qty": int(m.group(1)), "qty_max": None, "unit": unit, "name": name}
    # «2 яйца» в начале завтрака и т.п. — уже выше; всё остальное — только исходный текст
    return {"source_text": p, "qty": None, "qty_max": None, "unit": None, "name": p}


def split_steps(method: str):
    parts = [s.strip() for s in method.strip().rstrip(".").split(";") if s.strip()]
    steps = []
    for s in parts:
        s = s[0].upper() + s[1:]
        temp = re.search(r"(\d+(?:[–-]\d+)?)\s*°C", s)
        mins = re.search(r"(\d+(?:[–-]\d+)?)\s*мин", s)
        steps.append({
            "text": s + ".",
            "temperature_c": temp.group(1).replace("-", "–") if temp else None,
            "minutes": mins.group(1).replace("-", "–") if mins else None,
        })
    return steps


def parse_docx_titles(path: Path):
    """Названия рецептов из docx (заголовки 2-го уровня) — для сверки с таблицей."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf8")
    titles = []
    for para in re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S):
        if re.search(r'<w:pStyle w:val="(Heading2|2|Заголовок2)"', para):
            text = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", para))
            titles.append(text.strip())
    return titles


def main():
    xlsx = Path(sys.argv[1])
    docx = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    wb = openpyxl.load_workbook(xlsx, data_only=False)

    # --- Памятка ------------------------------------------------------------
    memo = []
    for row in wb["Памятка"].iter_rows(min_row=2, values_only=True):
        k, v = row[0], row[1]
        if k and v is not None and not str(v).startswith("=") and str(k).strip() not in EXCLUDED_MEMO:
            memo.append({"label": str(k).strip(), "text": str(v).strip()})

    # --- Рецепты ------------------------------------------------------------
    recipes = []
    for row in wb["Рецепты"].iter_rows(min_row=2, values_only=True):
        rtype, title, yld, ingr, method = row
        if not title:
            continue
        rid = RECIPE_IDS[title]
        ym = re.match(r"^(\d+)(?:[–-](\d+))?\s+порц", yld)
        base = int(ym.group(1)) if ym and not ym.group(2) else None
        storage = ["cool_fast", "freeze"]
        if RECIPE_TYPES[rtype] in ("main", "side"):
            storage = ["meat_3_4", "cool_fast", "freeze", "veg_separate", "reheat"]
        if rid in FISH:
            storage.insert(2, "fish_thaw")
        if RECIPE_TYPES[rtype] in ("breakfast", "snack"):
            storage = ["work_fridge", "cool_fast"]
        recipes.append({
            "id": rid,
            "title": title,
            "type": RECIPE_TYPES[rtype],
            "type_label": rtype,
            "yield_text": yld,
            "servings": base,
            "scalable": base is not None,
            "ingredients_text": ingr,
            "ingredients": [parse_ingredient(p) for p in ingr.split(";") if p.strip()],
            "method_text": method,
            "steps": split_steps(method),
            "storage_ids": storage,
            "source": "Таблица «Рецепты» + docx «Рецепты к меню»",
        })
    assert len(recipes) == 28, len(recipes)
    assert len({r["id"] for r in recipes}) == 28

    if docx:
        titles = parse_docx_titles(docx)
        if titles:
            missing = set(RECIPE_IDS) - set(titles)
            assert not missing, f"Нет в docx: {missing}"
            print(f"  docx: найдено {len(titles)} заголовков, все 28 рецептов совпадают с таблицей")

    # --- Календарь ----------------------------------------------------------
    calendar = []
    for row in wb["Меню 30 дней"].iter_rows(min_row=2, values_only=True):
        n, date, wd, br, lu, sn, di, tr, kcal, drinks, note = row
        if not n:
            continue
        d = dt.datetime.strptime(date, "%d.%m.%Y").date() if isinstance(date, str) else date.date()
        relax = str(br).upper().startswith("РЕЛАКС")
        assert WEEKDAYS[d.weekday()] == wd, (date, wd)
        calendar.append({
            "date": d.isoformat(),
            "day_number": int(n),
            "weekday": wd,
            "relax_day": relax,
            "meals": None if relax else {"breakfast": br.strip(), "lunch": lu.strip(), "snack": sn.strip(), "dinner": di.strip()},
            "relax_meals_text": {"breakfast": br, "lunch": lu, "snack": sn, "dinner": di} if relax else None,
            "training": {"template_id": TRAINING_LABELS[tr.strip()], "label": tr.strip()},
            "kcal_note": kcal,
            "drinks": drinks,
            "note": note,
        })
    assert len(calendar) == 30
    assert calendar[0]["date"] == "2026-11-02" and calendar[-1]["date"] == "2026-12-01"

    # --- Словарь соответствий -----------------------------------------------
    rec_ids = {r["id"] for r in recipes}
    meal_map = []
    for key, (kind, rid, comment) in sorted(COMPONENTS.items()):
        assert rid is None or rid in rec_ids, rid
        meal_map.append({"match": norm(key), "scope": "component", "kind": kind, "recipe_id": rid, "comment": comment})
    for key, (kind, rid, comment) in sorted(WHOLE.items()):
        assert rid is None or rid in rec_ids, rid
        meal_map.append({"match": norm(key), "scope": "whole", "kind": kind, "recipe_id": rid, "comment": comment})
    keys = {(m["scope"], m["match"]) for m in meal_map}
    unresolved = []
    for day in calendar:
        if not day["meals"]:
            continue
        for slot, text in day["meals"].items():
            if slot in ("lunch", "dinner"):
                for comp in text.split(" + "):
                    if ("component", norm(comp)) not in keys:
                        unresolved.append((day["date"], slot, comp))
            else:
                if ("whole", norm(text)) not in keys:
                    unresolved.append((day["date"], slot, text))
    assert not unresolved, unresolved

    # --- Закупки ------------------------------------------------------------
    purchases = []
    ws = wb["Закупки"]
    for row in ws.iter_rows(min_row=2, values_only=True):
        cat, name, unit, q1, q2, price, *_rest = row
        if not cat or not name or cat in ("ИТОГО ЗАКУПОК", "ЛИМИТ, ₽", "ЗАПАС/ПЕРЕРАСХОД, ₽", "*Внимание"):
            continue
        if not isinstance(q1, (int, float)):
            continue
        note = row[9]
        if name in NOTE_DROPPED_FOR:
            note = None
        purchases.append({
            "id": f"p{len(purchases) + 1:02d}",
            "category": cat, "name": name, "unit": unit,
            "qty_1_15": q1, "qty_16_30": q2,
            "price_per_unit_rub": price, "note": note,
        })
    total = sum(p["qty_1_15"] * p["price_per_unit_rub"] + p["qty_16_30"] * p["price_per_unit_rub"] for p in purchases)
    assert round(total) == 29668, total
    warning = None
    for row in ws.iter_rows(values_only=True):
        if row[0] == "*Внимание":
            warning = row[1]

    def event_items(key):
        items = []
        for p in purchases:
            q = p[key]
            if not q:
                continue
            items.append({
                "item_id": p["id"], "category": p["category"], "name": p["name"], "unit": p["unit"],
                "qty": q, "price_per_unit_rub": p["price_per_unit_rub"],
                "price_estimate_rub": round(q * p["price_per_unit_rub"], 2), "note": p["note"],
            })
        return items

    shopping_events = [
        {"id": "shop-2026-11-01", "date": "2026-11-01", "title": "Закупка на 1–15 дни", "purchase_key": "qty_1_15", "for_dates_text": "02.11–16.11", "items": event_items("qty_1_15")},
        {"id": "shop-2026-11-16", "date": "2026-11-16", "title": "Закупка на 16–30 дни", "purchase_key": "qty_16_30", "for_dates_text": "16.11–01.12", "items": event_items("qty_16_30")},
    ]

    # --- Готовка ------------------------------------------------------------
    cooking = []
    for row in wb["Готовка"].iter_rows(min_row=2, values_only=True):
        when, what, for_days, storage = row
        if not when:
            continue
        ddmm = when.split()[0]
        iso = ddmm_to_iso(ddmm)
        is_relax = "РЕЛАКС" in what.upper()
        ev = {
            "id": f"cook-{iso}",
            "date": iso,
            "weekday": when.split()[1] if len(when.split()) > 1 else None,
            "event_type": "relax_day" if is_relax else "meal_prep",
            "title": "Релакс-день" if is_relax else "Готовка",
            "source_text": what,
            "for_days_text": for_days,
            "for_dates": parse_for_dates(for_days),
            "storage": storage,
            "dishes": [],
        }
        if not is_relax:
            ev["dishes"] = [
                {"text": t, "recipe_ids": ids, "comment": COOK_NOTES.get(t)} for t, ids in COOK_DISHES[ddmm]
            ]
        cooking.append(ev)
    meal_prep = [c for c in cooking if c["event_type"] == "meal_prep"]
    assert len(cooking) == 10 and len(meal_prep) == 9
    assert any(c["date"] == "2026-11-28" for c in meal_prep)
    assert any(c["date"] == "2026-11-29" and c["event_type"] == "relax_day" for c in cooking)

    seed = {
        "seed_id": "god-v-forme-2026-11-v1",
        "schema_version": "1.0.0",
        "title": "Мой год в форме — стартовый план",
        "period": {"from": "2026-11-02", "to": "2026-12-01"},
        "sources": [
            "План_питания_2ноя_1дек_2026.xlsx (листы «Памятка», «Меню 30 дней», «Закупки», «Готовка», «Рецепты»)",
            "Рецепты_к_меню_ноябрь_2026.docx",
            "ТЗ «Мой год в форме» v1.0, раздел 5 (тренировки)",
        ],
        "profile": {
            "start_weight_kg": 107,
            "target_weight_kg": 82,
            "horizon_text": "≈12 месяцев",
            "kcal_reference": 2450,
            "kcal_note": "≈2450 ккал/сутки — оценочный стартовый ориентир, не рассчитан по каждому блюду.",
            "meal_times": {"breakfast": "08:30", "lunch": "12:00", "snack": "16:30", "dinner": "20:00–21:30"},
            "weekend_note": "Выходные: можно 2 основных приёма + перекус по голоду; не надо насильно есть 4 раза.",
            "cooking_days_text": "Обычно воскресенье и среда; блюда партиями на 2–3 дня.",
            "shopping_text": "Дважды в месяц: 1 и 16 ноября.",
            "budget_limit_rub": 30000,
            "relax_days": ["2026-11-29"],
            "drinks": "Вода, некрепкие травяные чаи без сахара, морсы без сахара; без кофе, энергетиков, лимонадов.",
            "exclusions": "Без мёда, дорадо и сардин.",
            "kitchen": "Плита, аэрогриль, электрогриль. Духовка не нужна.",
            "training_equipment": ["Мини-степпер", "Одна разборная гиря до 24 кг", "Собственный вес"],
            "kettlebell_max_kg": 24,
            "control": "Взвешивание 1 раз в неделю, тенденция за 2–3 недели.",
        },
        "memo": memo,
        "storage_guide": STORAGE_GUIDE,
        "calendar": calendar,
        "workout_templates": TEMPLATES,
        "exercise_library": EXERCISES,
        "recipes": recipes,
        "meal_recipe_map": meal_map,
        "shopping": {
            "budget_limit_rub": 30000,
            "model_total_rub": round(total),
            "price_warning": warning,
            "categories_order": SHOP_CATEGORY_ORDER,
            "purchases": purchases,
            "shopping_events": shopping_events,
        },
        "cooking_events": cooking,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(seed, ensure_ascii=False, indent=1), encoding="utf8")
    print(f"OK: {OUT}")
    print(f"  дней: {len(calendar)}, рецептов: {len(recipes)}, товаров: {len(purchases)}, "
          f"закупок: {len(shopping_events)}, готовок: {len(meal_prep)} (+ релакс), упражнений: {len(EXERCISES)}")
    print(f"  бюджетная модель: {round(total)} ₽")
    kinds = {}
    for m in meal_map:
        kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
    print(f"  словарь соответствий: {kinds}")
    unparsed = [(r["id"], i["source_text"]) for r in recipes for i in r["ingredients"] if i["qty"] is None]
    print(f"  ингредиентов без количества (показываются текстом): {len(unparsed)}")


if __name__ == "__main__":
    main()
