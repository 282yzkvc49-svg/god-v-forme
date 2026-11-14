#!/usr/bin/env python3
"""
Сборка шаблона плана питания из проверенного комплекта «Азбука вкуса» v2: python3 -I tools/build_av_plan.py [--report]

Вход:  tools/source/av_verified_menu_v2.json — комплект на 16.11–15.12.2026 (61 рецепт, 48 товаров av.ru —
       только индивидуальные карточки av.ru/i/…, календарь, 8 партий готовки, 2 закупки),
       tools/source/av_catalog_audit_v2.csv — замены товарных карточек по сравнению с прошлой версией,
       tools/legacy/legacy_catalog.json — прежнее меню (только для истории; скумбрия — только там).
Выход: src/data/plan_template.json, меню-часть src/data/initial_seed.json (памятка, соответствие блюд рецептам).

Что делает:
- товары av.ru → продукты приложения: ссылка, статус ссылки (карточка товара или подборка), фасовка и цена упаковки
  (как ориентир, не корзина), съедобная доля, срок хранения дома, можно ли заморозить;
- 61 рецепт → блюда: состав на 1 порцию, шаги, оборудование, время, хранение;
- 24 домашних дня комплекта → 24 дня меню шаблона (командировки и релакс-день — календарные, их ставит приложение);
- 8 партий готовки → готовки шаблона с теми же блюдами, количеством порций и назначениями; день готовки закреплён
  за днём меню, как в комплекте;
- проверяет: 30/24/5/1 дней, 24 разных завтрака, 61 рецепт, 48 обедов и ужинов ровно по одной порции из партий,
  суммы партий = состав × порции, все продукты из каталога, расчёт закупок комплекта.
Закупки с упаковками, докупками скоропортящегося и остатками считает само приложение (src/domain/plan.ts).
"""
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "source", "av_verified_menu_v2.json")
AUDIT = os.path.join(HERE, "source", "av_catalog_audit_v2.csv")
AV_CARD = re.compile(r"^https://av\.ru/i/\d+/?$")
LEGACY = os.path.join(HERE, "legacy", "legacy_catalog.json")
OUT = os.path.join(ROOT, "src", "data", "plan_template.json")
SEED_PATH = os.path.join(ROOT, "src", "data", "initial_seed.json")

seed = json.load(open(SRC, encoding="utf-8"))
legacy = json.load(open(LEGACY, encoding="utf-8"))
errors = []


def err(*a):
    errors.append(" ".join(str(x) for x in a))


SLOTS = ("breakfast", "lunch", "snack", "dinner")
CATEGORIES = ["Мясо и птица", "Рыба и морепродукты", "Яйца", "Молочные продукты", "Крупы и бобовые", "Хлеб и выпечка",
              "Овощи свежие", "Овощи замороженные", "Зелень", "Фрукты", "Ягоды и фрукты замороженные", "Орехи и семена",
              "Консервы и готовые продукты", "Масла и соусы", "Специи"]

# ------------------------------------------------------------------ товары: хранение дома и подписи
# (категория приложения, где хранить, срок после покупки в днях, можно ли заморозить, подпись фасовки,
#  примечание к массе в рецептах, масса 1 шт. съедобной части для подсказки «≈N шт.»)
F, Z, P = "fridge", "freezer", "pantry"
META = {
    "chicken": ("Мясо и птица", F, 3, True, "лоток 865 г", "сырое филе", None),
    "turkey": ("Мясо и птица", F, 3, True, "лоток 700 г", "сырое филе", None),
    "turkey_mince": ("Мясо и птица", F, 2, True, "лоток 450 г", "сырой фарш", None),
    "beef_mince": ("Мясо и птица", F, 2, True, "лоток 500 г", "сырой фарш", None),
    "pollock": ("Рыба и морепродукты", Z, 180, False, "упаковка 300 г", "сырое филе", None),
    "trout": ("Рыба и морепродукты", F, 2, True, "стейк ≈300 г", "масса стейка с костью; съедобная часть ≈82%", None),
    "tuna": ("Консервы и готовые продукты", P, 365, False, "банка 185 г", "масса без жидкости (≈75% банки)", None),
    "egg": ("Яйца", F, 25, False, "упаковка 10 шт.", None, None),
    "curd": ("Молочные продукты", F, 7, False, "пачка 200 г", None, None),
    "yogurt": ("Молочные продукты", F, 14, False, "стакан 250 г", None, None),
    "parmesan": ("Молочные продукты", F, 30, False, "упаковка 100 г", None, None),
    "oats": ("Крупы и бобовые", P, 180, False, "пачка 500 г", "сухие хлопья", None),
    "buckwheat": ("Крупы и бобовые", P, 365, False, "пачка 900 г", "сухая крупа", None),
    "rice": ("Крупы и бобовые", P, 365, False, "пачка 500 г", "сухая крупа", None),
    "bulgur": ("Крупы и бобовые", P, 365, False, "пачка 500 г", "сухая крупа", None),
    "pasta": ("Крупы и бобовые", P, 365, False, "пачка 450 г", "сухие макароны", None),
    "lentils": ("Крупы и бобовые", P, 365, False, "пачка 450 г", "сухая чечевица", None),
    "beans": ("Консервы и готовые продукты", P, 365, False, "банка 400 г", "масса без жидкости (≈60% банки)", None),
    "chickpeas": ("Консервы и готовые продукты", P, 365, False, "банка 400 г", "масса без жидкости (≈60% банки)", None),
    "tomatopuree": ("Консервы и готовые продукты", P, 365, False, "банка 400 г", None, None),
    "bread": ("Хлеб и выпечка", F, 3, True, "буханка 400 г", None, None),
    "potato": ("Овощи свежие", P, 30, False, "сетка 2 кг", "очищенный", 150),
    "carrot": ("Овощи свежие", F, 30, False, "пакет 1,5 кг", "очищенная", 100),
    "onion": ("Овощи свежие", P, 60, False, "сетка 500 г", "очищенный", 90),
    "garlic": ("Овощи свежие", P, 60, False, "упаковка 50 г", "очищенный", 5),
    "tomato": ("Овощи свежие", F, 7, False, "упаковка 500 г", None, 110),
    "cucumber": ("Овощи свежие", F, 7, False, "упаковка 500 г", None, 110),
    "pepper": ("Овощи свежие", F, 10, False, "упаковка ≈400 г", "без семян", 150),
    "zucchini": ("Овощи свежие", F, 10, False, "упаковка ≈400 г", "очищенный", 200),
    "mushroom": ("Овощи свежие", F, 4, False, "лоток 400 г", None, None),
    "broccoli": ("Овощи замороженные", Z, 180, False, "пакет 400 г", None, None),
    "greenbeans": ("Овощи замороженные", Z, 180, False, "пакет 400 г", None, None),
    "avocado": ("Фрукты", F, 5, False, "упаковка 2 шт. (≈400 г)", "мякоть без кожуры и косточки", 130),
    "banana": ("Фрукты", F, 6, False, "≈1 кг", "мякоть без кожуры", 120),
    "apple": ("Фрукты", F, 30, False, "упаковка ≈500 г", "без сердцевины", 150),
    "orange": ("Фрукты", F, 14, False, "упаковка ≈500 г", "очищенная мякоть", 150),
    "pear": ("Фрукты", F, 10, False, "упаковка ≈500 г", "без сердцевины", 150),
    "kiwi": ("Фрукты", F, 14, False, "упаковка ≈500 г", "очищенная мякоть", 70),
    "lemon": ("Фрукты", F, 21, False, "упаковка ≈500 г", "мякоть и сок", 80),
    "strawberry": ("Ягоды и фрукты замороженные", Z, 180, False, "пакет 300 г", "замороженная", None),
    "cherry": ("Ягоды и фрукты замороженные", Z, 180, False, "пакет 300 г", "замороженная", None),
    "walnuts": ("Орехи и семена", P, 90, False, "пакет 200 г", None, None),
    "almonds": ("Орехи и семена", P, 90, False, "пакет 120 г", None, None),
    "oliveoil": ("Масла и соусы", P, 365, False, "бутылка 500 мл", "1 ч. л. ≈ 5 мл, 1 ст. л. ≈ 15 мл", None),
    "paprika": ("Специи", P, 365, False, "упаковка 25 г", None, None),
    "cinnamon": ("Специи", P, 365, False, "упаковка 20 г", None, None),
    "curry": ("Специи", P, 365, False, "упаковка 30 г", None, None),
    "salt": ("Специи", P, 3650, False, "пачка 500 г", None, None),
}
UNIT = {"g": "g", "мл": "ml", "ml": "ml", "шт.": "pcs", "pcs": "pcs"}
RUNIT = {"г": "g", "мл": "ml", "шт.": "pcs"}

products = []
P_BY = {}
for p in seed["product_catalog"]:
    pid = p["id"]
    if pid not in META:
        err("нет описания хранения для товара", pid)
        continue
    if not AV_CARD.match(p["product_url"]) or p.get("listing_status") != "individual_product_page":
        err(pid, "не индивидуальная карточка av.ru:", p["product_url"])
    cat, storage, shelf, freezable, label, note, piece = META[pid]
    unit = UNIT[p["pack_unit"]]
    n = p["nutrition_per_100"]
    nutr = dict(kcal=n["kcal"], p=n["protein_g"], f=n["fat_g"], c=n["carbs_g"])
    piece_g, piece_label = None, None
    if pid == "egg":  # в комплекте — на 1 яйцо; в приложении — на 100 г при 1 яйце ≈50 г
        piece_g, piece_label = 50, "1 яйцо ≈ 50 г без скорлупы"
        nutr = {k: round(v * 2, 2) for k, v in nutr.items()}
    elif unit == "ml":  # в комплекте — на 1 мл; в приложении — на 100 мл
        nutr = {k: round(v * 100, 2) for k, v in nutr.items()}
    elif piece:
        piece_g = piece
    per = 1 if unit == "pcs" else 1000
    price = round(p["listed_price_rub"] / p["pack_quantity"] * per, 4)
    prod = dict(
        id=pid, name=p["product_name"], category=cat, unit=unit, nutr=nutr, nutr_src="ref",
        price=price, pack=dict(size=p["pack_quantity"], label=label), shelf_days=shelf, storage=storage,
        freezable=freezable, edible_ratio=p["usable_fraction"], piece_g=piece_g, piece_label=piece_label, note=note,
        pantry=False,
        url=p["product_url"], listing_status=p["listing_status"], availability="not_verified",
        pack_price=p["listed_price_rub"], av_category=p["category"], av_note=p.get("notes") or None,
        checked_date=p.get("catalog_page_checked_date"),
    )
    products.append(prod)
    P_BY[pid] = prod
for pid in META:
    if pid not in P_BY:
        err("лишнее описание хранения для товара, которого нет в комплекте:", pid)
# прежние продукты — только для истории (совпадающие id берутся из комплекта)
for p in legacy["products"]:
    if p["id"] not in P_BY:
        products.append(p)
# замены товарных карточек по сравнению с прошлой версией комплекта
audit = []
with open(AUDIT, encoding="utf-8-sig") as f:
    for line in f.read().splitlines()[1:]:
        if not line.strip():
            continue
        pid, old, new, note = (line.split(";") + ["", "", "", ""])[:4]
        by = [x["id"] for x in P_BY.values() if x["url"].rstrip("/") == new.rstrip("/")]
        if not by or (pid in P_BY and pid not in by):
            err("замена из аудита не совпадает с каталогом:", pid, new)
        # товар убран из комплекта (тыквенные семечки) — в рецептах его заменил другой товар каталога
        rec = dict(id=pid, old=old if old.startswith("http") else None, new=new, note=note,
                   removed=pid not in P_BY, now=by[0] if by else None, name=P_BY[pid]["name"] if pid in P_BY else None, recipes=[])
        if pid == "pumpkinseeds":
            # в v2 семечки заменены миндалём в этих рецептах (сверено с прошлой версией комплекта)
            rec["name"] = "Тыквенные семечки (убраны из комплекта)"
            rec["recipes"] = ["B05", "B14", "B24", "S03", "S07", "S12"]
            for rid in rec["recipes"]:
                r = next(x for x in seed["recipes"] if x["id"] == rid)
                if not any(i["product_id"] == "almonds" for i in r["ingredients"]):
                    err(rid, "ожидался миндаль вместо тыквенных семечек")
        audit.append(rec)
for r in seed["recipes"]:
    for i in r["ingredients"]:
        if i["product_id"] not in P_BY:
            err(r["id"], "ингредиент ссылается на товар не из каталога:", i["product_id"])

# ------------------------------------------------------------------ рецепты
REC = {r["id"]: r for r in seed["recipes"]}
FISH = {"pollock", "trout"}
EXTRA_NOTE = {
    "D01": "Салат (огурец и помидор) нарежьте и заправьте в день, когда едите порцию; в контейнере — отдельно от горячего.",
    "D07": "Салат (огурец и помидор) нарежьте и заправьте в день, когда едите порцию; в контейнере — отдельно от горячего.",
    "D08": "Шакшуку можно приготовить и в день ужина (20–25 минут) — так яйца вкуснее; продукты и порция те же.",
    "D09": "В комплекте блюдо названо «с цельнозерновой пастой», а в каталоге — спагетти Barilla №5 (не цельнозерновые). "
           "Если найдёте цельнозерновые — подойдут те же 100 г.",
}


def parse_step(t):
    m = re.search(r"(\d{2,3})\s*°\s*C", t)
    mm = re.search(r"(\d+(?:[–-]\d+)?)\s*(?:минут|мин)", t)
    return dict(text=t.strip(), temperature_c=m.group(1) if m else None, minutes=mm.group(1).replace("-", "–") if mm else None)


dishes = []
for r in seed["recipes"]:
    kind = "fresh" if r["kind"] in ("breakfast", "snack") else "batch"
    ingr = []
    for i in r["ingredients"]:
        if i["product_id"] not in P_BY:
            err(r["id"], "неизвестный товар", i["product_id"])
            continue
        if RUNIT[i["unit"]] != P_BY[i["product_id"]]["unit"]:
            err(r["id"], i["product_id"], "единица", i["unit"], "≠", P_BY[i["product_id"]]["unit"])
        ingr.append(dict(product=i["product_id"], qty=i["quantity"], note=None))
    fish = any(i["product"] in FISH for i in ingr)
    if kind == "batch":
        storage = dict(place="fridge", days=1 if fish else 3, freezable=True)
    else:
        storage = dict(place="fridge", days=1, freezable=False)
    notes = [x for x in (r.get("notes") or "", EXTRA_NOTE.get(r["id"], "")) if x]
    if kind == "batch" and fish:
        notes.append("Готовую рыбу лучше съесть в день приготовления или на следующий.")
    est = r["estimated_nutrition_per_portion"]
    dishes.append(dict(
        id=r["id"], title=r["title"], short=r["title"], category=r["kind"], kind=kind, unit="portion",
        unit_label=None, cooked_factor=None, serving_g=None, ingredients=ingr, spices=[],
        steps=[parse_step(s) for s in r["steps"]], method=r["equipment"], storage=storage,
        note=" ".join(notes) or None, legacy=None,
        active_minutes=r.get("active_minutes"), portable=r.get("portable"), storage_text=r.get("storage"),
        nutrition_estimate=dict(kcal=est["kcal"], p=est["protein_g"], f=est["fat_g"], c=est["carbs_g"]),
    ))
D_BY = {d["id"]: d for d in dishes}
for d in legacy["dishes"]:
    if d["id"] in D_BY:
        err("id прежнего блюда совпадает с рецептом комплекта", d["id"])
    dishes.append(d)

# ------------------------------------------------------------------ календарь → дни меню
cal = seed["calendar"]
types = Counter(c["day_type"] for c in cal)
if len(cal) != 30 or types != Counter(home=24, travel=5, relax=1):
    err("календарь", len(cal), dict(types))
start = seed["meta"]["start_date"]
if cal[0]["date"] != start:
    err("первый день календаря", cal[0]["date"], "≠", start)
home = [c for c in cal if c["day_type"] == "home"]
TDAY = {c["date"]: k + 1 for k, c in enumerate(home)}
days = []
for c in home:
    meals = {}
    for s in SLOTS:
        rid = c["meal_plan"][s]["recipe_id"]
        if rid not in REC:
            err(c["date"], s, "нет рецепта", rid)
            continue
        if REC[rid]["kind"] != s:
            err(c["date"], s, rid, "— рецепт для", REC[rid]["kind"])
        meals[s] = dict(parts=[dict(dish=rid, qty=1, fresh=D_BY[rid]["kind"] == "fresh")])
    days.append(dict(day=TDAY[c["date"]], relax=False, meals=meals, seed_date=c["date"]))
bf = [c["meal_plan"]["breakfast"]["recipe_id"] for c in home]
if len(set(bf)) != 24:
    err("завтраков разных", len(set(bf)))

# ------------------------------------------------------------------ партии готовки
need_ld = {(c["date"], s): c["meal_plan"][s]["recipe_id"] for c in home for s in ("lunch", "dinner")}
alloc = Counter()
blocks = []
for e in seed["cooking_events"]:
    cd = e["date"]
    if cd == date.fromordinal(date.fromisoformat(start).toordinal() - 1).isoformat():
        bday = 0
    elif cd in TDAY:
        bday = TDAY[cd]
    else:
        err(e["id"], "готовка не в домашний день", cd)
        continue
    items = []
    lunch_same = False
    for r in e["recipes"]:
        rid = r["recipe_id"]
        if r["cook_servings"] != len(r["allocations"]):
            err(e["id"], rid, "порций", r["cook_servings"], "назначений", len(r["allocations"]))
        per = defaultdict(float)
        for i in REC[rid]["ingredients"]:
            per[i["product_id"]] += i["quantity"] * r["cook_servings"]
        tot = {i["product_id"]: i["quantity"] for i in r["total_ingredients"]}
        for k in set(per) | set(tot):
            if abs(per.get(k, 0) - tot.get(k, 0)) > 0.51:
                err(e["id"], rid, k, "на партию", tot.get(k), "≠ состав × порции", per.get(k))
        uses = []
        for a in r["allocations"]:
            key = (a["date"], a["meal"])
            alloc[key] += 1
            if need_ld.get(key) != rid:
                err(e["id"], rid, "назначен на", key, "а в меню", need_ld.get(key))
            if a["date"] < cd:
                err(e["id"], rid, "съедается раньше готовки", key)
            if a["date"] == cd and a["meal"] == "lunch":
                lunch_same = True
            gap = (date.fromisoformat(a["date"]) - date.fromisoformat(cd)).days
            st = "fridge" if gap <= D_BY[rid]["storage"]["days"] else "freeze"
            uses.append(dict(day=TDAY[a["date"]], slot=a["meal"], qty=1, via=None, storage=st))
        items.append(dict(dish=rid, uses=uses))
    blocks.append(dict(id=e["id"], day=bday, when="morning" if lunch_same else "evening", kind="main", pinned=True,
                       items=items, seed_date=cd))
missing = [k for k in need_ld if alloc[k] == 0]
dup = [k for k, n in alloc.items() if n > 1]
if missing or dup or sum(alloc.values()) != 48:
    err("обеды и ужины: назначено", sum(alloc.values()), "без порции", missing, "дважды", dup)

# ------------------------------------------------------------------ закупки комплекта (для сверки в приложении)
carry = defaultdict(float)
orders = []
for o in seed["shopping_orders"]:
    lines = []
    for l in o["lines"]:
        p = P_BY[l["product_id"]]
        gross = l["need_recipe_quantity"] / p["edible_ratio"]
        packs = math.ceil(max(0.0, gross - carry[l["product_id"]]) / p["pack"]["size"] - 1e-9)
        if packs != l["packs"] or abs(packs * p["pack_price"] - l["line_cost_rub"]) > 0.01:
            err(o["id"], l["product_id"], "упаковок", l["packs"], "по расчёту", packs)
        carry[l["product_id"]] += packs * p["pack"]["size"] - gross
        lines.append(dict(product=l["product_id"], need=l["need_recipe_quantity"], packs=l["packs"],
                          cost=l["line_cost_rub"], leftover=l["leftover_inventory_after_period"]))
    sub = round(sum(x["cost"] for x in lines), 2)
    if abs(sub - o["known_price_subtotal_rub"]) > 0.01:
        err(o["id"], "сумма", sub, "≠", o["known_price_subtotal_rub"])
    orders.append(dict(id=o["id"], date=o["date"], title=o["title"], period=[o["period_start"], o["period_end"]],
                       subtotal=sub, note=o.get("note"), lines=lines))

# ------------------------------------------------------------------ калорийность (как в приложении)
def grams(p, q):
    return q * (p["piece_g"] or 0) if p["unit"] == "pcs" else q


def dish_kcal(did, qty=1):
    t = [0.0, 0.0, 0.0, 0.0]
    for i in D_BY[did]["ingredients"]:
        p = P_BY[i["product"]]
        g = grams(p, i["qty"] * qty) / 100
        for k, key in enumerate(("kcal", "p", "f", "c")):
            t[k] += p["nutr"][key] * g
    return t


report = []
for d in days:
    t = [sum(x) for x in zip(*(dish_kcal(d["meals"][s]["parts"][0]["dish"]) for s in SLOTS))]
    report.append((d["day"], d["seed_date"], t))
for d in dishes[:61]:
    k = dish_kcal(d["id"])[0]
    if abs(k - d["nutrition_estimate"]["kcal"]) > 1.5:
        err(d["id"], "ккал", round(k, 1), "≠ комплект", d["nutrition_estimate"]["kcal"])
ks = [r[2][0] for r in report]
avg = [round(sum(r[2][k] for r in report) / len(report)) for k in range(4)]

meta = seed["meta"]
out = dict(
    id=seed["seed_id"], title="«Азбука вкуса»: меню на 30 дней", base_start=start, length=meta["days"], relax_day=14,
    kcal_target=meta["daily_kcal_estimate_target"], budget_rub=meta["budget_rub_home_only"],
    nutrition_sources="Калорийность и БЖУ — расчётные, по справочным значениям из комплекта «Азбука вкуса» "
                      "(не сверены с этикетками av.ru).",
    price_note="Цены — опубликованные на av.ru на 14.11.2026 (карточки товаров и подборки). Это ориентир, а не корзина: "
               "наличие и доставка по адресу не проверены, итоговая цена — при оформлении заказа.",
    categories=CATEGORIES, products=products, dishes=dishes, days=days, blocks=blocks, topup_candidates=[],
    source=dict(
        seed_id=seed["seed_id"], schema_version=seed["schema_version"], price_snapshot=meta["price_snapshot"],
        address_delivery_status=meta["address_delivery_status"], dining_rules=meta["dining_rules"],
        protein_target=meta["protein_gram_target_approx"], validation=seed["validation"],
        calendar=[dict(date=c["date"], type=c["day_type"], city=c.get("city"),
                       meals={s: c["meal_plan"][s]["recipe_id"] for s in SLOTS} if c["day_type"] == "home" else None)
                  for c in cal],
        cooking=[dict(id=e["id"], date=e["date"], items=[dict(dish=r["recipe_id"], servings=r["cook_servings"],
                                                              uses=[[a["date"], a["meal"]] for a in r["allocations"]])
                                                         for r in e["recipes"]]) for e in seed["cooking_events"]],
        orders=orders, audit=audit,
        kcal=dict(avg=avg[0], min=round(min(ks)), max=round(max(ks)), protein=avg[1]),
    ),
)

if "--report" in sys.argv:
    for day, d, t in report:
        print(f"{day:2d} {d}: {t[0]:.0f} ккал, Б {t[1]:.0f} Ж {t[2]:.0f} У {t[3]:.0f}")
    print("среднее", avg, "мин", round(min(ks)), "макс", round(max(ks)))
    for b in blocks:
        print(b["id"], b["day"], b["when"], [(i["dish"], [(u["day"], u["slot"][0], u["storage"]) for u in i["uses"]]) for i in b["items"]])

if errors:
    print("ОШИБКИ:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"OK: {OUT} — {len(P_BY)} товаров av.ru, {len(D_BY)} рецептов, {len(days)} дней меню, {len(blocks)} партий, "
      f"{sum(alloc.values())} обедов и ужинов из партий; ≈{avg[0]} ккал/день ({round(min(ks))}–{round(max(ks))}); "
      f"закупки комплекта {sum(o['subtotal'] for o in orders):.2f} ₽ (+ прежний справочник для истории)")

# ------------------------------------------------------------------ initial_seed.json: памятка и соответствие блюд рецептам
iseed = json.load(open(SEED_PATH, encoding="utf-8"))
pr = iseed["profile"]
pr["kcal_note"] = (f"≈{meta['daily_kcal_estimate_target']} ккал/сутки — ориентир; расчётная средняя домашних дней ≈{avg[0]} ккал "
                   "(по справочным данным, не по этикеткам).")
pr["cooking_days_text"] = "8 партий за 30 дней: обеды на 2–4 дня и ужины; порции позже 3 дней — в морозилку."
pr["shopping_text"] = "Две основные закупки на av.ru (15.11 и к готовке 30.11); скоропортящееся — небольшими докупками."
pr["exclusions"] = "Без мёда, дорадо, сардин, скумбрии, алкоголя, кофе, энергетиков и сладких лимонадов."
memo = {m["label"]: m["text"] for m in iseed["memo"]}
memo["Энергия, старт"] = (f"≈{meta['daily_kcal_estimate_target']} ккал/сутки — ориентир; по дням меню {round(min(ks))}–{round(max(ks))} ккал, "
                          f"в среднем ≈{avg[0]} (расчёт, не по этикеткам)")
memo["Белок / жиры / углеводы"] = f"в среднем ≈{avg[1]} г / {avg[2]} г / {avg[3]} г в день"
memo["Готовка"] = "8 партий: в день готовки — обед и ужины на 2–4 дня; что не съедите за 3 дня — в морозилку; рыбу — в день готовки или на следующий"
memo["Закупки"] = "Две основные на av.ru (15.11 и к 30.11) + небольшие докупки свежего; цены — ориентир с av.ru, не корзина"
memo["Релакс-день"] = "Один в календарный месяц (в ноябре — 29.11): свободная еда без подсчёта, алкоголь исключён"
memo["Исключения"] = "Без мёда, дорадо, сардин, скумбрии, алкоголя, кофе, энергетиков и сладких лимонадов"
memo["Важно про КБЖУ"] = "Калорийность расчётная — по справочным значениям комплекта; этикетки av.ru не сверены. Вручную ничего вводить не нужно."
memo["Важно про бюджет"] = (f"Бюджет домашней еды {meta['budget_rub_home_only']:,} ₽".replace(",", " ")
                            + ". Цены — с av.ru на 14.11.2026, ориентир; наличие и доставка по адресу не проверены.")
iseed["memo"] = [{"label": k, "text": v} for k, v in memo.items()]
iseed["meal_recipe_map"] = [dict(match=r["title"].lower(), scope="whole", kind="exact", recipe_id=r["id"], comment=None)
                            for r in seed["recipes"]]
iseed["sources"] = [f"Комплект «Азбука вкуса» {seed['seed_id']}: tools/source/av_verified_menu_v2.json + av_catalog_audit_v2.csv → tools/build_av_plan.py → src/data/plan_template.json",
                    "Прежнее меню (до 14.11.2026) — только для истории: tools/legacy/",
                    "ТЗ «Мой год в форме» и корректировки: оборудование, командировки, релакс-дни, дата старта"]
with open(SEED_PATH, "w", encoding="utf-8") as f:
    json.dump(iseed, f, ensure_ascii=False, indent=1)
print("OK:", SEED_PATH)
