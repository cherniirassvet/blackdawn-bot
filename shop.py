# -*- coding: utf-8 -*-
"""Разбор сообщения к донату: что человек купил и на какой SteamID."""

import re

STEAM_RE = re.compile(r'STEAM_[0-5]:[01]:\d+', re.I)
# запись через пробелы и подчёркивания тоже встречается
STEAM_LOOSE = re.compile(r'STEAM[\s_]*([0-5])[\s:_]+([01])[\s:_]+(\d+)', re.I)


def find_steamid(text):
    """Вернуть SteamID в каноническом виде или None."""
    if not text:
        return None
    m = STEAM_RE.search(text)
    if m:
        return m.group(0).upper()
    m = STEAM_LOOSE.search(text)
    if m:
        return 'STEAM_%s:%s:%s' % (m.group(1), m.group(2), m.group(3))
    return None


class Item(object):
    def __init__(self, kind, days, price, currency):
        self.kind = kind          # vip или admin
        self.days = days          # 0 = навсегда
        self.price = price
        self.currency = currency

    @property
    def key(self):
        return '%s_%s' % (self.kind, 'forever' if self.days == 0 else 'month')

    @property
    def title(self):
        base = 'VIP' if self.kind == 'vip' else 'Админка'
        return base + (' навсегда' if self.days == 0 else ' на %d дн.' % self.days)


class Shop(object):
    def __init__(self, section):
        g = lambda k, d: [w.strip().lower() for w in section.get(k, d).split(',') if w.strip()]
        self.vip_words = g('vip_words', 'вип,vip')
        self.admin_words = g('admin_words', 'админ,admin')
        self.forever_words = g('forever_words', 'навсегда,forever')

        self.items = {}
        for key in ('vip_month', 'vip_forever', 'admin_month', 'admin_forever'):
            if key not in section:
                continue
            parts = [p.strip() for p in section[key].split('|')]
            if len(parts) < 3:
                raise ValueError('строка %r должна быть вида: дней | цена | валюта' % key)
            kind = 'vip' if key.startswith('vip') else 'admin'
            self.items[key] = Item(kind, int(parts[0]), float(parts[1]), parts[2].upper())

    @staticmethod
    def _first_hit(low, words):
        """Позиция самого раннего вхождения любого слова, или None."""
        best = None
        for w in words:
            i = low.find(w)
            if i >= 0 and (best is None or i < best):
                best = i
        return best

    def match(self, text):
        """Определить позицию по тексту доната. Вернуть Item или None.

        Тип и срок ищем по отдельности: «админка навсегда» не должна
        превращаться в месячную только потому, что слово написано слитно.
        """
        low = (text or '').lower()
        vi = self._first_hit(low, self.vip_words)
        ai = self._first_hit(low, self.admin_words)

        if vi is None and ai is None:
            return None
        if ai is None:
            kind = 'vip'
        elif vi is None:
            kind = 'admin'
        else:
            kind = 'vip' if vi < ai else 'admin'

        forever = self._first_hit(low, self.forever_words) is not None
        return self.items.get('%s_%s' % (kind, 'forever' if forever else 'month'))

    @staticmethod
    def price_ok(item, amount, currency):
        """Сходится ли сумма. Ноль в прайсе значит «не проверять»."""
        if not item or item.price <= 0:
            return True
        if currency and item.currency and currency.upper() != item.currency:
            return False        # валюта другая — пусть решает человек
        try:
            return float(amount) + 0.001 >= item.price
        except (TypeError, ValueError):
            return False
