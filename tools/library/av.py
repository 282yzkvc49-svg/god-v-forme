"""Журнал проверки товаров на av.ru → src/data/library/av_check.json.
A(pid, url, name, size, unit, price, label=(kcal,p,f,c)|None, note='', label_pack='')  — карточка найдена, цена указана
N(pid, note) — подходящей карточки не найдено
Дата проверки — CHECK (по умолчанию сегодня)."""
import json, sys
from pathlib import Path
P = Path(__file__).resolve().parents[2] / 'src/data/library/av_check.json'
CHECK = '2026-11-24'
def _load():
    return json.loads(P.read_text('utf-8')) if P.exists() else {}
def _save(d):
    P.write_text(json.dumps(dict(sorted(d.items())), ensure_ascii=False, indent=1) + '\n', 'utf-8')
def A(pid, url, name, size, unit, price, label=None, note='', pack_label='', alts=()):
    d = _load()
    d[pid] = {'status': 'listed', 'url': url, 'name': name, 'pack': {'size': size, 'unit': unit, 'label': pack_label or f'{size} {"г" if unit=="g" else "мл" if unit=="ml" else "шт."}'},
              'price': price, 'checkedAt': CHECK,
              'label': dict(zip(['kcal', 'p', 'f', 'c'], label)) if label else None, 'note': note, 'alts': list(alts)}
    _save(d)
def N(pid, note):
    d = _load()
    d[pid] = {'status': 'not_found', 'checkedAt': CHECK, 'note': note}
    _save(d)
