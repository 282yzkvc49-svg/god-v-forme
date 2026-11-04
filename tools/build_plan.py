#!/usr/bin/env python3
"""
Сборка шаблона плана питания: python3 -I tools/build_plan.py [--report]

Читает tools/plan_products.py, plan_dishes.py, plan_menu.py, распределяет порции блюд из партий
по приёмам пищи, проверяет согласованность (порции, сроки хранения, наличие продуктов и рецептов),
считает калорийность по дням и пишет src/data/plan_template.json.
Сдвиг на реальную дату старта, закупки с упаковками и «есть дома» считает приложение (src/domain/plan.ts)
по этим же данным.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plan_products import PRODUCTS, CATEGORIES  # noqa: E402
from plan_dishes import DISHES  # noqa: E402
from plan_menu import MENU, BLOCKS, TOPUP_CANDIDATES  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src", "data", "plan_template.json")

SLOTS = ["breakfast", "lunch", "snack", "dinner"]
SHORT = dict(b="breakfast", l="lunch", s="snack", d="dinner")
SLOT_POS = dict(breakfast=1, lunch=3, snack=5, dinner=7)
WHEN_POS = dict(morning=2, evening=6)
DAYS = 30
RELAX = 28
KCAL_TARGET = 2450

P = {p["id"]: p for p in PRODUCTS}
Dm = {d["id"]: d for d in DISHES}
errors = []


def err(msg):
    errors.append(msg)


# ---------------------------------------------------------------- проверка справочников
for d in DISHES:
    for i in d["ingredients"]:
        if i["product"] not in P and i["product"] not in Dm:
            err(f"{d['id']}: нет продукта {i['product']}")
        if i["product"] in Dm and Dm[i["product"]]["kind"] != "batch":
            err(f"{d['id']}: вложенное блюдо {i['product']} должно быть из партии")
    if not d["steps"]:
        err(f"{d['id']}: нет шагов рецепта")
    if d["unit"] == "g" and not d["cooked_factor"]:
        err(f"{d['id']}: нет коэффициента выхода")
for p in PRODUCTS:
    if p["category"] not in CATEGORIES:
        err(f"{p['id']}: неизвестная категория {p['category']}")

# ---------------------------------------------------------------- пищевая ценность
def dish_nutr(dish_id, qty):
    """(kcal, p, f, c, label_products) для qty единиц блюда, включая вложенные блюда."""
    d = Dm[dish_id]
    tot = [0.0, 0.0, 0.0, 0.0]
    labels = set()
    for i in d["ingredients"]:
        q = i["qty"] * qty
        if i["product"] in Dm:
            n = dish_nutr(i["product"], q)
            for k in range(4):
                tot[k] += n[k]
            labels |= n[4]
            continue
        p = P[i["product"]]
        grams = q * (p["piece_g"] or 1) if p["unit"] == "pcs" else q
        for k, key in enumerate(("kcal", "p", "f", "c")):
            tot[k] += p["nutr"][key] * grams / 100
        if p["nutr_src"] == "label":
            labels.add(p["name"])
    return (*tot, labels)


# ---------------------------------------------------------------- подгонка калорийности
# Базовые граммовки из plan_menu.py подгоняются к ≈2450 ккал за счёт гарниров (шаг — 10 г хлеба, 25 г
# картофеля, 5 г крупы): сначала хлеб или картофель к ужину, затем крупа к обеду. Итоговые граммы
# записываются в шаблон, приложение их не меняет.
TUNE = [  # (слот, блюдо, шаг, максимум)
    ("d", "bread", 10, 100), ("d", "potato_airfryer", 25, 350), ("d", "grain_bulgur", 5, 90),
    ("l", "grain_rice", 5, 110), ("l", "grain_buckwheat", 5, 110), ("l", "grain_bulgur", 5, 110),
    ("l", "grain_couscous", 5, 110), ("l", "grain_quinoa", 5, 100), ("l", "grain_barley", 5, 110),
    ("l", "potato_airfryer", 25, 400),
]


def menu_kcal(m):
    return sum(dish_nutr(t[0], t[1])[0] for k in SHORT for t in m[k])


def tune_day(m):
    m = {k: [list(t) for t in v] for k, v in m.items()}
    for (k, dish, step, cap) in TUNE:
        for t in m[k]:
            if t[0] != dish:
                continue
            per = dish_nutr(dish, step)[0]
            while t[1] + step <= cap and menu_kcal(m) + per / 2 < KCAL_TARGET:
                t[1] += step
    return {k: [tuple(t) for t in v] for k, v in m.items()}


# ---------------------------------------------------------------- приёмы пищи → части
for day, m in list(MENU.items()):
    if m:
        MENU[day] = tune_day(m)
days = []
batch_uses = []  # (day, slot, dish, qty, via)
for day in range(1, DAYS + 1):
    m = MENU.get(day)
    if day == RELAX:
        if m is not None:
            err("в релакс-день не должно быть меню")
        days.append(dict(day=day, relax=True, meals=None))
        continue
    if not m or set(m) != set(SHORT):
        err(f"день {day}: нужно 4 приёма пищи")
        continue
    meals = {}
    for k, slot in SHORT.items():
        parts = []
        for t in m[k]:
            dish, qty = t[0], t[1]
            fresh = len(t) > 2 and t[2] == "fresh"
            if dish not in Dm:
                err(f"день {day} {slot}: нет блюда {dish}")
                continue
            dd = Dm[dish]
            parts.append(dict(dish=dish, qty=qty, fresh=fresh or dd["kind"] != "batch"))
            if dd["kind"] == "batch" and not fresh:
                batch_uses.append((day, slot, dish, qty, None))
            if dd["kind"] == "fresh" or fresh:
                for i in dd["ingredients"]:
                    if i["product"] in Dm:  # готовая индейка, крупа, гранола из партии
                        batch_uses.append((day, slot, i["product"], i["qty"] * qty, dish))
        meals[slot] = dict(parts=parts)
    days.append(dict(day=day, relax=False, meals=meals))

# ---------------------------------------------------------------- распределение по партиям
blocks = []
for b in BLOCKS:
    blocks.append(dict(id=b["id"], day=b["day"], when=b["when"], kind=b["kind"],
                       pos=b["day"] * 10 + WHEN_POS[b["when"]], items={d: [] for d in b["dishes"]}))
for b in blocks:
    for d in b["items"]:
        if d not in Dm or Dm[d]["kind"] != "batch":
            err(f"готовка {b['id']}: {d} не блюдо из партии")

for (day, slot, dish, qty, via) in batch_uses:
    pos = day * 10 + SLOT_POS[slot]
    cand = [b for b in blocks if dish in b["items"] and b["pos"] < pos]
    if not cand:
        err(f"день {day} {slot}: блюдо {dish} не приготовлено ни в одной готовке до этого приёма")
        continue
    b = max(cand, key=lambda x: x["pos"])
    gap = day - b["day"]
    st = Dm[dish]["storage"]
    storage = "fridge" if st["place"] == "fridge" and gap <= st["days"] else (
        "pantry" if st["place"] == "pantry" and gap <= st["days"] else "freeze")
    if storage == "freeze" and not st["freezable"]:
        err(f"день {day} {slot}: {dish} из {b['id']} — {gap} дн., а заморозить нельзя")
    b["items"][dish].append(dict(day=day, slot=slot, qty=round(qty, 3), via=via, storage=storage))

for b in blocks:
    for d, uses in b["items"].items():
        if not uses:
            err(f"готовка {b['id']}: {d} никуда не назначено (лишняя партия)")

report = []
for d in days:
    if d["relax"]:
        report.append((d["day"], None))
        continue
    tot = [0.0, 0.0, 0.0, 0.0]
    per = {}
    for slot in SLOTS:
        s = [0.0] * 4
        for part in d["meals"][slot]["parts"]:
            n = dish_nutr(part["dish"], part["qty"])
            for k in range(4):
                s[k] += n[k]
        per[slot] = s
        for k in range(4):
            tot[k] += s[k]
    report.append((d["day"], tot, per))

# ---------------------------------------------------------------- проверки калорийности
for r in report:
    if r[1] is None:
        continue
    kcal = r[1][0]
    if not (2300 <= kcal <= 2600):
        err(f"день {r[0]}: {kcal:.0f} ккал вне 2300–2600")

# ---------------------------------------------------------------- вывод
if "--report" in sys.argv or errors:
    for r in report:
        if r[1] is None:
            print(f"{r[0]:>2}: релакс-день")
            continue
        t, per = r[1], r[2]
        print(f"{r[0]:>2}: {t[0]:5.0f} ккал  Б {t[1]:4.0f}  Ж {t[2]:4.0f}  У {t[3]:4.0f}   " +
              "  ".join(f"{s[:1]}:{per[s][0]:4.0f}" for s in SLOTS))
    ks = [r[1][0] for r in report if r[1]]
    print(f"среднее {sum(ks) / len(ks):.0f} ккал, мин {min(ks):.0f}, макс {max(ks):.0f}; "
          f"белок в среднем {sum(r[1][1] for r in report if r[1]) / len(ks):.0f} г")
    for b in blocks:
        print(b["id"], {d: [(u["day"], u["slot"][0], u["qty"], u["storage"][:2]) for u in us] for d, us in b["items"].items()})

if errors:
    print("\nОШИБКИ:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

out = dict(
    id="menu-30-v2",
    title="Меню на 30 дней с граммовками",
    base_start="2026-11-02",
    length=DAYS,
    relax_day=RELAX,
    kcal_target=KCAL_TARGET,
    budget_rub=30000,
    nutrition_sources="Справочные данные на 100 г: USDA FoodData Central (SR Legacy), И. М. Скурихин «Химический состав "
                      "российских пищевых продуктов». Продукты, состав которых зависит от марки, помечены «по этикетке».",
    price_note="Цены ориентировочные (₽ за кг, л или шт.), не проверены в конкретном магазине.",
    categories=CATEGORIES,
    products=PRODUCTS,
    dishes=DISHES,
    days=days,
    blocks=[dict(id=b["id"], day=b["day"], when=b["when"], kind=b["kind"],
                 items=[dict(dish=d, uses=u) for d, u in b["items"].items()]) for b in blocks],
    topup_candidates=TOPUP_CANDIDATES,
)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"OK: {OUT} — {len(PRODUCTS)} продуктов, {len(DISHES)} блюд, {len(blocks)} готовок, "
      f"{sum(1 for d in days if not d['relax']) * 4} приёмов пищи")


# ---------------------------------------------------------------- initial_seed.json: профиль, памятка, тренировки
SEED_PATH = os.path.join(ROOT, "src", "data", "initial_seed.json")
SAFETY = ("Без работы до отказа: заканчивайте подход, когда в запасе 2–3 повтора. Дышите ровно, не задерживайте дыхание. "
          "При боли или дискомфорте — остановите упражнение; интенсивно не тренируйтесь, если что-то болит.")


def update_seed(kcal_avg, p_avg, f_avg, c_avg):
    with open(SEED_PATH, encoding="utf-8") as f:
        seed = json.load(f)
    seed["seed_id"] = "god-v-forme-2026-11-v2"
    seed["schema_version"] = "2.0"
    for k in ("calendar", "recipes", "shopping", "cooking_events", "period"):
        seed.pop(k, None)
    pr = seed["profile"]
    pr.pop("kettlebell_max_kg", None)
    pr["training_equipment"] = ["Мини-степпер", "Гиря 12 кг", "Гиря 16 кг", "Собственный вес"]
    pr["kettlebells_kg"] = [12, 16]
    pr["training_rules"] = SAFETY
    pr["kcal_note"] = "≈2450 ккал/сутки; калорийность каждого приёма пищи считается по справочным данным."
    pr["cooking_days_text"] = "2 основные готовки в неделю (вечер буднего дня и выходной) + быстрая готовка рыбы перед ужином."
    pr["shopping_text"] = "Две основные закупки: накануне старта и к 14-му дню плана; скоропортящееся — небольшими докупками."
    pr["relax_days"] = []
    pr["exclusions"] = "Без мёда, дорадо, сардин, алкоголя, кофе, энергетиков и сладких лимонадов."
    pr["drinks"] = "Вода, травяные чаи и морсы без сахара; без кофе, энергетиков, лимонадов и алкоголя."
    memo = {m["label"]: m["text"] for m in seed["memo"]}
    memo["Энергия, старт"] = f"≈2450 ккал/сутки; по дням меню {MIN_K}–{MAX_K} ккал (справочные данные)"
    memo["Белок / жиры / углеводы"] = f"в среднем ≈{p_avg} г / {f_avg} г / {c_avg} г в день (≈{kcal_avg} ккал)"
    memo["Готовка"] = "2 основные готовки в неделю + быстрая готовка рыбы перед ужином; блюда на 2–3 дня, остальное сразу в морозилку"
    memo["Закупки"] = "Две основные: накануне старта и к 14-му дню плана; молочное, бананы, зелень и овощи — небольшими докупками"
    memo["Релакс-день"] = "28-й день плана (переносится вместе с датой старта): меню свободное, алкоголь исключён"
    memo["Тренировки"] = "Мини-степпер, гиря 12 кг, гиря 16 кг и собственный вес"
    memo["Исключения"] = "Без мёда, дорадо, сардин, алкоголя, кофе, энергетиков и сладких лимонадов"
    memo["Важно про КБЖУ"] = ("Калорийность считается по справочным таблицам (USDA, Скурихин). Если в блюде есть продукт, состав "
                              "которого зависит от марки (лаваш, сыр, фарш, хлебцы), — «требует уточнения» по этикетке.")
    memo["Важно про бюджет"] = "Цены ориентировочные, не проверены в магазине. Фактические можно вписать в закупке."
    for k in ("Завтрак", "Обед", "Перекус", "Ужин"):
        memo.pop(k, None)
    seed["memo"] = [{"label": k, "text": v} for k, v in memo.items()]
    ex = {e["id"]: e for e in seed["exercise_library"]}
    ex["goblet_squat"]["warnings"] = ["Гиря 12 кг. Переход на 16 кг — только осознанно, при чистой технике во всех повторах.",
                                      "Боль в колене или спине — прекратите подход."]
    ex["kb_floor_press"]["warnings"] = ["Только если уверенно и безопасно контролируете гирю 12 кг; иначе — отжимания от устойчивого возвышения.",
                                        "Брать и класть гирю — только перекатом на бок, не над лицом."]
    ex["kb_floor_press"]["easier"] = "Отжимания от устойчивого возвышения 2×8."
    ex["kb_rdl"]["warnings"] = ["Гиря 16 кг; если спина округляется или техника нарушается — 12 кг.",
                                "Боль в пояснице — прекратите подход."]
    ex["kb_row"]["warnings"] = ["Гиря 12 кг.", "Ставьте гирю на пол, сгибая ноги, а не спину."]
    ex["incline_push_up"] = {
        "id": "incline_push_up", "name": "Отжимания от устойчивого возвышения",
        "equipment": ["Собственный вес", "Устойчивая опора: край стола, подоконник, диван"], "kind": "reps",
        "figure": "incline_push_up", "muscles": "Грудь, трицепс, передняя дельта, корпус",
        "frames": ["Исходное: ладони на краю опоры, тело прямое", "Ключевое: грудь у края опоры"],
        "steps": ["Поставьте ладони на край устойчивой опоры чуть шире плеч.",
                  "Отойдите ногами назад, чтобы тело стало прямой линией от головы до пяток.",
                  "Вдох — сгибайте локти и опускайте грудь к краю опоры; локти примерно под 30–45° к корпусу.",
                  "Выдох — выпрямите руки, сохраняя прямую линию тела."],
        "mistakes": ["Провисание поясницы", "Таз поднят вверх", "Локти разведены под 90°", "Опора сдвигается"],
        "easier": "Опора повыше (столешница или стена).",
        "warnings": ["Опора должна стоять неподвижно: не используйте стул на колёсиках и скользящую мебель."],
    }
    for e in ex.values():
        if e["kind"] in ("reps", "time") and not any("задерживайте дыхание" in w for w in e["warnings"]):
            e["warnings"].append("Не задерживайте дыхание; не работайте до отказа.")
    seed["exercise_library"] = list(ex.values())
    seed["workout_templates"] = [
        dict(id="strength_a", name="Силовая А", type="strength", duration_min=[25, 30], rest_sec=[60, 90],
             description="Всё тело: степпер, гиря 12 кг и собственный вес. " + SAFETY,
             items=[dict(exercise_id="warmup_stepper", sets=1, minutes=5, note="Разминка, спокойный темп"),
                    dict(exercise_id="goblet_squat", sets=2, reps=8, kettlebell_kg=12),
                    dict(exercise_id="kb_row", sets=2, reps=8, per_side="руку", kettlebell_kg=12),
                    dict(exercise_id="push_up", sets=2, reps=8, kettlebell_kg=None,
                         note="Если классические не получаются с прямым телом — от устойчивого возвышения"),
                    dict(exercise_id="glute_bridge", sets=2, reps=12, kettlebell_kg=None),
                    dict(exercise_id="plank", sets=2, seconds=20, kettlebell_kg=None)]),
        dict(id="strength_b", name="Силовая Б", type="strength", duration_min=[25, 30], rest_sec=[60, 90],
             description="Наклон, жим, выпады и боковая планка: гири 16 и 12 кг и собственный вес. " + SAFETY,
             items=[dict(exercise_id="warmup_stepper", sets=1, minutes=5, note="Разминка, спокойный темп"),
                    dict(exercise_id="kb_rdl", sets=2, reps=10, kettlebell_kg=16, fallback_kg=12,
                         condition="При нарушении техники — гиря 12 кг"),
                    dict(exercise_id="kb_floor_press", sets=2, reps=8, per_side="руку", kettlebell_kg=12,
                         condition="Только если уверенно и безопасно контролируете вес",
                         alternative=dict(exercise_id="incline_push_up", reps=8,
                                          note="Если гиря неустойчива в руке — отжимания от устойчивого возвышения 2×8")),
                    dict(exercise_id="reverse_lunge", sets=2, reps=6, per_side="ногу", kettlebell_kg=None, note="Без гири"),
                    dict(exercise_id="kb_row", sets=2, reps=10, per_side="руку", kettlebell_kg=12),
                    dict(exercise_id="side_plank", sets=2, seconds=20, per_side="сторону", kettlebell_kg=None)]),
        dict(id="stepper", name="Степпер", type="cardio", duration_min=[15, 20], rest_sec=None,
             description="Мини-степпер в спокойном темпе: дыхание учащено, но можно говорить. Время увеличивайте постепенно — "
                         "на 1–2 минуты в неделю, если предыдущее давалось легко.",
             items=[dict(exercise_id="stepper_cardio", sets=1, minutes=[15, 20],
                         note="Спокойный темп; начните с 15 минут")]),
        dict(id="recovery", name="Восстановление", type="recovery", duration_min=None, rest_sec=None,
             description="Прогулка или лёгкая активность по самочувствию — без силовой нагрузки.",
             items=[dict(exercise_id="walk", sets=1, note="По самочувствию")]),
    ]
    seed["sources"] = ["Меню на 30 дней с граммовками: tools/plan_*.py → src/data/plan_template.json",
                       "Исходные блюда: План_питания_2ноя_1дек_2026.xlsx и Рецепты_к_меню_ноябрь_2026.docx",
                       "ТЗ «Мой год в форме», корректировки: меню, оборудование, порции, закупки, дата старта"]
    with open(SEED_PATH, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=1)
    print("OK:", SEED_PATH)


ks = [r[1] for r in report if r[1]]
MIN_K, MAX_K = round(min(k[0] for k in ks)), round(max(k[0] for k in ks))
update_seed(round(sum(k[0] for k in ks) / len(ks)), round(sum(k[1] for k in ks) / len(ks)),
            round(sum(k[2] for k in ks) / len(ks)), round(sum(k[3] for k in ks) / len(ks)))
