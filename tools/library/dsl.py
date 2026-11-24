"""Компактная запись рецептов библиотеки → src/data/library/*.json.

R(id, kind, title, cuisine, protein, base, servings, ing, steps, time, store, tags)
  ing   — 'pid qty [примечание]; pid qty ...'  (количество на всю партию: мясо/рыба сырые, крупы сухие, овощи очищенные)
  steps — строки: 'текст' | 'мин|текст' | 'прибор|мин|текст' | 'прибор|темп|мин|текст'
  store — (суток в холодильнике, месяцев в морозилке или 0[, примечание])
Загрузка техники считается по шагам. Повторный запуск заменяет рецепты с тем же id.
"""
import json, re, sys
from pathlib import Path

LIB = Path(__file__).resolve().parents[2] / 'src/data/library'
FILES = {'breakfast': 'breakfasts.json', 'snack': 'snacks.json', 'main': 'mains.json'}
EQUIP = ['аэрогриль', 'электрогриль', 'плита']
THAW = 'Накануне вечером переложить в холодильник'
REHEAT = 'Под крышкой до горячего пара по всей порции'

def num(s):
    f = float(s.replace(',', '.'))
    return int(f) if f.is_integer() else f

def ing(s):
    out = []
    for part in [x.strip() for x in s.split(';') if x.strip()]:
        m = re.match(r'(\S+)\s+([\d.,]+)\s*(.*)$', part)
        if not m: raise ValueError(f'ингредиент: {part}')
        d = {'p': m.group(1), 'q': num(m.group(2))}
        if m.group(3).strip(): d['note'] = m.group(3).strip()
        out.append(d)
    return out

def steps(lst):
    out = []
    for s in lst:
        p = s.split('|')
        if len(p) == 1: out.append({'t': p[0]})
        elif len(p) == 2: out.append({'t': p[1], 'min': p[0]})
        elif len(p) == 3: out.append({'t': p[2], 'eq': p[0], 'min': p[1]})
        elif len(p) == 4: out.append({'t': p[3], 'eq': p[0], 'temp': p[1], 'min': p[2]})
        else: raise ValueError(s)
    return out

def maxmin(m):
    n = [int(x) for x in re.findall(r'\d+', m or '')]
    return max(n) if n else 0

ALL = []
def R(id, kind, title, cuisine, protein, base, servings, ing_s, step_l, time, store, tags=(), utensils=()):
    st = steps(step_l)
    eq = [e for e in EQUIP if any(x.get('eq') == e for x in st)] or ['без нагрева']
    r = {'id': id, 'kind': kind, 'title': title, 'cuisine': cuisine, 'protein': protein}
    if base: r['base'] = base
    r.update({'servings': servings, 'equipment': eq})
    if utensils: r['utensils'] = list(utensils)
    r['ingredients'] = ing(ing_s)
    r['steps'] = st
    r['time'] = {'active': time[0], 'total': time[1]}
    if kind == 'main':
        load = {}
        for x in st:
            if x.get('eq'): load[x['eq']] = load.get(x['eq'], 0) + maxmin(x.get('min'))
        r['load'] = load
    fridge, months = store[0], store[1]
    sto = {'fridge_days': fridge, 'freeze': bool(months)}
    if months:
        sto['freeze_months'] = months
        if kind == 'main': sto['thaw'] = THAW
        sto['reheat'] = REHEAT if kind == 'main' else 'Аэрогриль 170 °C, 4–5 минут, или комнатной температуры'
    if len(store) > 2 and store[2]: sto['note'] = store[2]
    r['storage'] = sto
    r['tags'] = list(tags)
    ALL.append(r)

def M(id, title, cuisine, protein, base, servings, ing_s, step_l, time, store, tags=('партия',), utensils=()):
    t = list(tags)
    if store[1] and 'заморозка' not in t: t.append('заморозка')
    if 'на работу' not in t and store[0] >= 2: t.append('на работу')
    R(id, 'main', title, cuisine, protein, base, servings, ing_s, step_l, time, store, t, utensils)

def B(id, title, cuisine, protein, base, servings, ing_s, step_l, time, store, tags=('на работу',), utensils=()):
    R(id, 'breakfast', title, cuisine, protein, base, servings, ing_s, step_l, time, store, tags, utensils)

def S(id, title, cuisine, protein, servings, ing_s, step_l, time, store, tags=('на работу', 'без разогрева'), utensils=()):
    R(id, 'snack', title, cuisine, protein, None, servings, ing_s, step_l, time, store, tags, utensils)

def save():
    for kind, f in FILES.items():
        path = LIB / f
        cur = json.loads(path.read_text('utf-8'))
        new = {r['id']: r for r in ALL if r['kind'] == kind}
        keep = [r for r in cur if r['id'] not in new]
        out = sorted(keep + list(new.values()), key=lambda r: r['id'])
        path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', 'utf-8')
    print(f'записано рецептов: {len(ALL)}')
