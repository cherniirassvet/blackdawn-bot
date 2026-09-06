# -*- coding: utf-8 -*-
"""
Чёрный Рассвет — телеграм-бот и автовыдача привилегий.

Что делает:
  * слушает донаты DonationAlerts по вебсокету и сразу выдаёт VIP или
    админку на игровом сервере по SteamID из сообщения к донату;
  * если разобрать донат не вышло — не гадает, а кладёт его в очередь
    и зовёт администратора;
  * отвечает игрокам в Telegram: онлайн, топ, ранг;
  * принимает жалобы и пересылает их администраторам.

Запуск:  python3 bot.py
Настройки: config.ini рядом с этим файлом.
"""

import asyncio
import configparser
import html
import json
import logging
import os
import re
import sys
import time

import aiohttp
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rcon
from shop import Shop, find_steamid

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'config.ini')
STATE = os.path.join(HERE, 'state.json')

DA = 'https://www.donationalerts.com'
WS = 'wss://centrifugo.donationalerts.com/connection/websocket'
SCOPES = 'oauth-user-show oauth-donation-index oauth-donation-subscribe'

log = logging.getLogger('bot')


# ======================================================================
#  Состояние на диске
# ======================================================================

def load_state():
    if os.path.exists(STATE):
        try:
            with open(STATE, encoding='utf-8') as f:
                return json.load(f)
        except (ValueError, OSError):
            log.warning('state.json битый, начинаю с чистого')
    return {'tokens': {}, 'done': [], 'pending': [], 'tg_offset': 0}


def save_state(st):
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)          # чтобы не потерять файл при обрыве


# ======================================================================
#  Telegram
# ======================================================================

class Telegram(object):
    def __init__(self, token, session):
        self.base = 'https://api.telegram.org/bot%s/' % token
        self.s = session

    async def call(self, method, **params):
        try:
            async with self.s.post(self.base + method, json=params,
                                   timeout=aiohttp.ClientTimeout(total=70)) as r:
                j = await r.json()
                if not j.get('ok'):
                    log.warning('telegram %s: %s', method, j.get('description'))
                    return None
                return j.get('result')
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            log.warning('telegram %s не ответил: %s', method, e)
            return None

    async def send(self, chat_id, text, **kw):
        return await self.call('sendMessage', chat_id=chat_id, text=text,
                               parse_mode='HTML', disable_web_page_preview=True, **kw)


def esc(s):
    return html.escape(str(s if s is not None else ''), quote=False)


# ======================================================================
#  DonationAlerts
# ======================================================================

class DonationAlerts(object):
    def __init__(self, cfg, state, session):
        self.cid = cfg['client_id'].strip()
        self.secret = cfg['client_secret'].strip()
        self.redirect = cfg['redirect_uri'].strip()
        self.st = state
        self.s = session

    @property
    def tokens(self):
        return self.st.setdefault('tokens', {})

    def authorize_url(self):
        from urllib.parse import urlencode
        return DA + '/oauth/authorize?' + urlencode({
            'client_id': self.cid, 'redirect_uri': self.redirect,
            'response_type': 'code', 'scope': SCOPES})

    async def exchange(self, code):
        data = {'grant_type': 'authorization_code', 'client_id': self.cid,
                'client_secret': self.secret, 'redirect_uri': self.redirect, 'code': code}
        async with self.s.post(DA + '/oauth/token', data=data) as r:
            j = await r.json()
        if 'access_token' not in j:
            raise RuntimeError('DonationAlerts не выдал токен: %s' % j)
        self._store(j)
        return j

    async def refresh(self):
        rt = self.tokens.get('refresh_token')
        if not rt:
            raise RuntimeError('нет refresh_token — прогони setup_da.py заново')
        data = {'grant_type': 'refresh_token', 'refresh_token': rt,
                'client_id': self.cid, 'client_secret': self.secret, 'scope': SCOPES}
        async with self.s.post(DA + '/oauth/token', data=data) as r:
            j = await r.json()
        if 'access_token' not in j:
            raise RuntimeError('обновление токена не удалось: %s' % j)
        self._store(j)
        return j

    def _store(self, j):
        self.tokens['access_token'] = j['access_token']
        if j.get('refresh_token'):
            self.tokens['refresh_token'] = j['refresh_token']
        self.tokens['expires_at'] = time.time() + int(j.get('expires_in', 3600)) - 120
        save_state(self.st)

    async def token(self):
        if not self.tokens.get('access_token'):
            raise RuntimeError('нет access_token — прогони setup_da.py')
        if time.time() >= self.tokens.get('expires_at', 0):
            await self.refresh()
        return self.tokens['access_token']

    async def api(self, path, method='GET', payload=None, retry=True):
        hdr = {'Authorization': 'Bearer ' + await self.token(),
               'Content-Type': 'application/json', 'Accept': 'application/json'}
        async with self.s.request(method, DA + path, headers=hdr,
                                  data=json.dumps(payload) if payload else None) as r:
            if r.status == 401 and retry:
                await self.refresh()
                return await self.api(path, method, payload, retry=False)
            r.raise_for_status()
            return await r.json()

    async def me(self):
        return (await self.api('/api/v1/user/oauth'))['data']

    async def recent(self):
        return (await self.api('/api/v1/alerts/donations')).get('data', [])

    async def sub_token(self, channel, client):
        j = await self.api('/api/v1/centrifuge/subscribe', 'POST',
                           {'channels': [channel], 'client': client})
        for ch in j.get('channels', []):
            if ch.get('channel') == channel:
                return ch['token']
        raise RuntimeError('не выдали токен на канал %s' % channel)


def dig_donation(obj):
    """Найти в ответе вебсокета объект доната, как бы он ни был завёрнут."""
    if isinstance(obj, dict):
        if 'username' in obj and 'amount' in obj and 'id' in obj:
            return obj
        for v in obj.values():
            found = dig_donation(v)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = dig_donation(v)
            if found:
                return found
    return None


# ======================================================================
#  Бот
# ======================================================================

class Bot(object):
    def __init__(self, cp):
        self.cp = cp
        self.st = load_state()

        t = cp['telegram']
        self.admins = [int(x) for x in t['admins'].replace(' ', '').split(',') if x]
        self.admin_chat = int(t['admin_chat']) if t.get('admin_chat', '').strip() else self.admins[0]

        s = cp['server']
        self.ip = s['ip'].strip()
        self.port = int(s['port'])
        self.rcon_pw = s['rcon_password'].strip()
        self.top_url = s.get('top_url', '').strip()

        self.shop = Shop(cp['shop'])
        self.session = None
        self.tg = None
        self.da = None

    # ---------- сервер ----------

    async def rcon(self, command):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: rcon.send(self.ip, self.port, self.rcon_pw, command))

    async def server_info(self):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: rcon.info(self.ip, self.port))

    async def grant(self, kind, steamid, days):
        """Выдать привилегию. Возвращает (успех, что ответил сервер)."""
        cmd = ('zma_admin "%s" %d' if kind == 'admin' else 'zma_vip "%s" %d') % (steamid, days)
        try:
            out = await self.rcon(cmd)
            return True, out or 'сервер принял команду молча'
        except Exception as e:            # noqa: BLE001 — нам важна любая причина
            return False, str(e)

    # ---------- топ ----------

    async def top_data(self):
        if not self.top_url:
            return None
        try:
            async with self.session.get(self.top_url,
                                        timeout=aiohttp.ClientTimeout(total=15)) as r:
                if r.status != 200:
                    return None
                return json.loads(await r.text())
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            return None

    # ---------- донаты ----------

    def already(self, alert_id):
        return alert_id in self.st.setdefault('done', [])

    def remember(self, alert_id):
        done = self.st.setdefault('done', [])
        done.append(alert_id)
        del done[:-500]                 # длинную историю не держим
        save_state(self.st)

    async def handle_donation(self, d):
        aid = d.get('id')
        if aid is None or self.already(aid):
            return
        self.remember(aid)

        who = d.get('username') or 'аноним'
        amount = d.get('amount')
        cur = (d.get('currency') or '').upper()
        msg = d.get('message') or ''

        head = ('<b>Донат</b> %s %s от <b>%s</b>\n<i>%s</i>'
                % (esc(amount), esc(cur), esc(who), esc(msg) or '— без сообщения —'))

        steamid = find_steamid(msg)
        item = self.shop.match(msg)

        if not item or not steamid:
            why = []
            if not item:
                why.append('не понял, что берут')
            if not steamid:
                why.append('нет SteamID')
            await self.park(d, head, ', '.join(why))
            return

        if not self.shop.price_ok(item, amount, cur):
            await self.park(d, head, 'сумма меньше цены «%s»' % item.title)
            return

        ok, out = await self.grant(item.kind, steamid, item.days)
        if ok:
            await self.tg.send(self.admin_chat,
                               head + '\n\n✅ Выдано: <b>%s</b>\nSteamID: <code>%s</code>'
                               % (esc(item.title), esc(steamid)))
            log.info('выдал %s -> %s', item.key, steamid)
        else:
            await self.park(d, head, 'сервер не принял команду: %s' % out,
                            steamid=steamid, item=item)

    async def park(self, d, head, why, steamid=None, item=None):
        """Отложить донат и позвать человека."""
        p = self.st.setdefault('pending', [])
        p.append({'id': d.get('id'), 'username': d.get('username'),
                  'amount': d.get('amount'), 'currency': d.get('currency'),
                  'message': d.get('message'), 'steamid': steamid,
                  'kind': item.kind if item else None,
                  'days': item.days if item else None,
                  'at': int(time.time())})
        del p[:-100]
        save_state(self.st)
        num = len(p)
        await self.tg.send(
            self.admin_chat,
            head + '\n\n⚠️ <b>Нужен ты:</b> %s.\nВ очереди под номером <b>%d</b>.\n'
                   'Выдать вручную: <code>/vip STEAM_0:1:… 30</code> '
                   'или <code>/admin STEAM_0:1:… 30</code>,\n'
                   'убрать из очереди: <code>/done %d</code>' % (esc(why), num, num))

    # ---------- вебсокет ----------

    async def da_loop(self):
        delay = 5
        while True:
            try:
                await self.da_once()
                delay = 5
            except asyncio.CancelledError:
                raise
            except Exception as e:      # noqa: BLE001
                log.warning('DonationAlerts отвалился: %s — переподключусь через %d с', e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 300)

    async def da_once(self):
        me = await self.da.me()
        uid = me['id']
        channel = '$alerts:donation_%s' % uid
        conn_token = me['socket_connection_token']

        async with websockets.connect(WS, ping_interval=25, ping_timeout=20) as ws:
            await ws.send(json.dumps({'params': {'token': conn_token}, 'id': 1}))
            raw = await asyncio.wait_for(ws.recv(), timeout=20)
            first = json.loads(raw)
            client = (first.get('result') or {}).get('client')
            if not client:
                raise RuntimeError('вебсокет не дал client: %s' % first)

            token = await self.da.sub_token(channel, client)
            await ws.send(json.dumps({'params': {'channel': channel, 'token': token},
                                      'method': 1, 'id': 2}))
            log.info('слушаю донаты, канал %s', channel)
            await self.catchup()

            while True:
                raw = await ws.recv()
                if not raw or raw.strip() in ('{}', ''):
                    await ws.send('{}')          # ответ на пинг
                    continue
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                d = dig_donation(data)
                if d:
                    await self.handle_donation(d)

    async def catchup(self):
        """Добрать донаты, пришедшие пока бот лежал."""
        try:
            for d in reversed(await self.da.recent()):
                await self.handle_donation(d)
        except Exception as e:          # noqa: BLE001
            log.warning('добрать историю донатов не вышло: %s', e)

    async def catchup_loop(self):
        while True:
            await asyncio.sleep(600)
            await self.catchup()

    # ---------- телеграм ----------

    HELP_USER = (
        '<b>Чёрный Рассвет</b>\n\n'
        '/online — кто сейчас на сервере\n'
        '/top — пятнадцать первых по убийствам\n'
        '/rank ник — место конкретного игрока\n'
        '/ip — адрес сервера\n\n'
        'Жалоба или спорный бан — просто напиши сюда текстом: '
        'свой ник, ник нарушителя, карту и примерное время. Передам администрации.')

    HELP_ADMIN = (
        '\n\n<b>Для администрации</b>\n'
        '/vip STEAM_0:1:… дней — выдать VIP (0 = навсегда)\n'
        '/admin STEAM_0:1:… дней — выдать админку\n'
        '/pending — донаты, которые бот не разобрал\n'
        '/done N — убрать из очереди\n'
        '/rcon команда — выполнить команду на сервере')

    def is_admin(self, uid):
        return uid in self.admins

    async def tg_loop(self):
        while True:
            try:
                upd = await self.tg.call('getUpdates',
                                         offset=self.st.get('tg_offset', 0),
                                         timeout=50, allowed_updates=['message'])
                if not upd:
                    continue
                for u in upd:
                    self.st['tg_offset'] = u['update_id'] + 1
                    try:
                        await self.on_message(u.get('message') or {})
                    except Exception as e:      # noqa: BLE001
                        log.exception('обработка сообщения упала: %s', e)
                save_state(self.st)
            except asyncio.CancelledError:
                raise
            except Exception as e:              # noqa: BLE001
                log.warning('telegram: %s', e)
                await asyncio.sleep(5)

    async def on_message(self, m):
        text = (m.get('text') or '').strip()
        chat = (m.get('chat') or {}).get('id')
        user = m.get('from') or {}
        uid = user.get('id')
        if not chat or not text:
            return

        low = text.lower()
        cmd = low.split()[0].split('@')[0]
        args = text.split()[1:]
        admin = self.is_admin(uid)

        if cmd in ('/start', '/help'):
            await self.tg.send(chat, self.HELP_USER + (self.HELP_ADMIN if admin else ''))
            return

        if cmd == '/ip':
            await self.tg.send(chat, 'Адрес сервера:\n<code>%s:%d</code>\n\n'
                                     'В консоли игры:\n<code>connect %s:%d</code>'
                                     % (self.ip, self.port, self.ip, self.port))
            return

        if cmd == '/online':
            info = await self.server_info()
            if not info:
                await self.tg.send(chat, 'Сервер не отвечает. Либо перезапускается, либо лежит.')
            else:
                await self.tg.send(chat, '<b>%s</b>\nКарта: <code>%s</code>\nИгроков: <b>%d</b> из %d'
                                   % (esc(info['name']), esc(info['map']),
                                      info['players'], info['max']))
            return

        if cmd == '/top':
            await self.cmd_top(chat)
            return

        if cmd == '/rank':
            await self.cmd_rank(chat, ' '.join(args))
            return

        if not admin:
            await self.complaint(m, chat, text)
            return

        # --------- команды администрации ---------
        if cmd in ('/vip', '/admin'):
            await self.cmd_grant(chat, cmd[1:], args)
        elif cmd == '/pending':
            await self.cmd_pending(chat)
        elif cmd == '/done':
            await self.cmd_done(chat, args)
        elif cmd == '/rcon':
            if not args:
                await self.tg.send(chat, 'Что выполнить? Например: <code>/rcon status</code>')
                return
            try:
                out = await self.rcon(' '.join(args))
            except Exception as e:      # noqa: BLE001
                out = 'не вышло: %s' % e
            await self.tg.send(chat, '<pre>%s</pre>' % esc(out[:3500] or 'пусто'))
        else:
            await self.complaint(m, chat, text)

    async def cmd_top(self, chat):
        j = await self.top_data()
        players = (j or {}).get('players') or []
        if not players:
            await self.tg.send(chat, 'Топ пока пуст или файл статистики недоступен.')
            return
        players.sort(key=lambda p: (-int(p.get('kills') or 0), -int(p.get('damage') or 0)))
        lines = ['<b>Пятнадцать первых</b>']
        for i, p in enumerate(players[:15], 1):
            lines.append('%2d. %s — <b>%s</b>' % (i, esc(p.get('name')), esc(p.get('kills'))))
        lines.append('\nСтатистика обновляется при смене карты.')
        await self.tg.send(chat, '\n'.join(lines))

    async def cmd_rank(self, chat, nick):
        if not nick:
            await self.tg.send(chat, 'Напиши ник: <code>/rank Вася</code>')
            return
        j = await self.top_data()
        players = (j or {}).get('players') or []
        if not players:
            await self.tg.send(chat, 'Файл статистики недоступен.')
            return
        players.sort(key=lambda p: (-int(p.get('kills') or 0), -int(p.get('damage') or 0)))
        low = nick.lower()
        for i, p in enumerate(players, 1):
            if low in str(p.get('name', '')).lower():
                await self.tg.send(
                    chat, '<b>%s</b>\nМесто: <b>%d</b> из %d\nУбийств: <b>%s</b>\nУрона: %s'
                    % (esc(p.get('name')), i, len(players),
                       esc(p.get('kills')), esc(p.get('damage'))))
                return
        await self.tg.send(chat, 'Не нашёл такого игрока в статистике.')

    async def cmd_grant(self, chat, kind, args):
        if len(args) < 2:
            await self.tg.send(chat, 'Формат: <code>/%s STEAM_0:1:12345 30</code> '
                                     '(0 дней = навсегда)' % kind)
            return
        steamid = find_steamid(args[0])
        if not steamid:
            await self.tg.send(chat, 'Это не похоже на SteamID: <code>%s</code>' % esc(args[0]))
            return
        try:
            days = int(args[1])
        except ValueError:
            await self.tg.send(chat, 'Дни числом, пожалуйста.')
            return
        ok, out = await self.grant(kind, steamid, days)
        if ok:
            await self.tg.send(chat, '✅ Выдано <b>%s</b> на <b>%s</b>.\nОтвет сервера: <code>%s</code>'
                               % ('админка' if kind == 'admin' else 'VIP', esc(steamid),
                                  esc((out or '')[:300])))
        else:
            await self.tg.send(chat, '❌ Не вышло: %s' % esc(out))

    async def cmd_pending(self, chat):
        p = self.st.get('pending') or []
        if not p:
            await self.tg.send(chat, 'Очередь пуста.')
            return
        lines = ['<b>Неразобранные донаты</b>']
        for i, d in enumerate(p, 1):
            lines.append('%d. %s %s от %s\n    <i>%s</i>'
                         % (i, esc(d.get('amount')), esc(d.get('currency')),
                            esc(d.get('username')), esc(d.get('message'))[:120]))
        lines.append('\nУбрать: <code>/done N</code>')
        await self.tg.send(chat, '\n'.join(lines))

    async def cmd_done(self, chat, args):
        p = self.st.get('pending') or []
        if not args or not args[0].isdigit():
            await self.tg.send(chat, 'Формат: <code>/done 1</code>')
            return
        n = int(args[0])
        if not 1 <= n <= len(p):
            await self.tg.send(chat, 'Нет такого номера.')
            return
        p.pop(n - 1)
        save_state(self.st)
        await self.tg.send(chat, 'Убрал. В очереди осталось: %d' % len(p))

    async def complaint(self, m, chat, text):
        u = m.get('from') or {}
        who = ' '.join(x for x in (u.get('first_name'), u.get('last_name')) if x) or 'без имени'
        tag = ('@' + u['username']) if u.get('username') else 'без ника'
        await self.tg.send(
            self.admin_chat,
            '<b>Сообщение от игрока</b>\n%s (%s, id <code>%s</code>)\n\n%s'
            % (esc(who), esc(tag), u.get('id'), esc(text)))
        await self.tg.send(chat, 'Передал администрации. Ответят здесь же.')

    # ---------- запуск ----------

    async def run(self):
        async with aiohttp.ClientSession() as session:
            self.session = session
            self.tg = Telegram(self.cp['telegram']['token'].strip(), session)
            self.da = DonationAlerts(self.cp['donationalerts'], self.st, session)

            me = await self.tg.call('getMe')
            if not me:
                raise SystemExit('Telegram не принял токен. Проверь config.ini.')
            log.info('бот @%s запущен', me.get('username'))
            await self.tg.send(self.admin_chat, '🟢 Бот запущен.')

            tasks = [asyncio.ensure_future(self.tg_loop())]
            if self.da.tokens.get('refresh_token'):
                tasks.append(asyncio.ensure_future(self.da_loop()))
                tasks.append(asyncio.ensure_future(self.catchup_loop()))
            else:
                log.warning('DonationAlerts не подключён — прогони setup_da.py')
                await self.tg.send(self.admin_chat,
                                   '⚠️ DonationAlerts не подключён: донаты приниматься '
                                   'не будут. Запусти <code>python3 setup_da.py</code>.')
            await asyncio.gather(*tasks)


def main():
    logging.basicConfig(level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s')
    if not os.path.exists(CONFIG):
        raise SystemExit('Нет config.ini. Скопируй config.example.ini и заполни.')
    cp = configparser.ConfigParser()
    cp.read(CONFIG, encoding='utf-8')
    bot = Bot(cp)
    try:
        asyncio.get_event_loop().run_until_complete(bot.run())
    except KeyboardInterrupt:
        log.info('остановлен с клавиатуры')


if __name__ == '__main__':
    main()
