# -*- coding: utf-8 -*-
"""
Одноразовая привязка DonationAlerts.

Запусти один раз:  python3 setup_da.py
Скрипт даст ссылку. Открываешь её в браузере (можно на телефоне),
разрешаешь доступ, тебя перекинет на несуществующую страницу
http://localhost:8080/callback?code=ДЛИННЫЙ_КОД — она не откроется,
это нормально. Скопируй адрес из строки браузера целиком и вставь сюда.

После этого бот сам будет обновлять токен и лезть в браузер больше не надо.
"""

import asyncio
import configparser
import os
import sys
from urllib.parse import urlparse, parse_qs

import aiohttp

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bot import CONFIG, DonationAlerts, load_state, save_state


def extract_code(s):
    s = s.strip()
    if not s:
        return None
    if 'code=' in s:
        q = parse_qs(urlparse(s).query)
        if q.get('code'):
            return q['code'][0]
        # на случай, если вставили только хвост
        return s.split('code=', 1)[1].split('&')[0]
    return s          # вставили сам код


async def main():
    if not os.path.exists(CONFIG):
        raise SystemExit('Нет config.ini рядом. Сначала заполни его.')
    cp = configparser.ConfigParser()
    cp.read(CONFIG, encoding='utf-8')
    st = load_state()

    async with aiohttp.ClientSession() as s:
        da = DonationAlerts(cp['donationalerts'], st, s)

        print()
        print('1. Открой эту ссылку в браузере и нажми «Разрешить»:')
        print()
        print('   ' + da.authorize_url())
        print()
        print('2. Тебя перекинет на страницу, которая не откроется — так и должно быть.')
        print('   Скопируй адрес из строки браузера целиком.')
        print()
        raw = input('Вставь адрес сюда и нажми Enter:\n> ')

        code = extract_code(raw)
        if not code:
            raise SystemExit('Не вижу кода в том, что вставлено.')

        await da.exchange(code)
        me = await da.me()
        save_state(st)

        print()
        print('Готово. Привязан аккаунт: %s (id %s)' % (me.get('name'), me.get('id')))
        print('Токены лежат в state.json. Теперь запускай бота: python3 bot.py')


if __name__ == '__main__':
    asyncio.get_event_loop().run_until_complete(main())
