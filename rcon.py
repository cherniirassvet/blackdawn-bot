# -*- coding: utf-8 -*-
"""
RCON для GoldSrc (Counter-Strike 1.6).

Протокол простой и без библиотек: сначала спрашиваем у сервера challenge,
потом шлём команду вместе с ним и паролем. Всё по UDP, поэтому ответ может
и не прийти — на это есть таймаут и повтор.
"""

import socket

HEADER = b'\xff\xff\xff\xff'


class RconError(Exception):
    pass


def _ask(sock, addr, payload, timeout):
    sock.settimeout(timeout)
    sock.sendto(HEADER + payload, addr)
    data, _ = sock.recvfrom(8192)
    if not data.startswith(HEADER):
        raise RconError('сервер ответил мусором')
    return data[4:]


def send(ip, port, password, command, timeout=4.0, retries=2):
    """Выполнить команду на сервере и вернуть его ответ строкой."""
    addr = (ip, int(port))
    last = None

    for _ in range(retries + 1):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            raw = _ask(sock, addr, b'challenge rcon\n', timeout)
            # ответ вида: challenge rcon 1234567890
            parts = raw.decode('utf-8', 'replace').split()
            if len(parts) < 3:
                raise RconError('не разобрал challenge')
            challenge = parts[2].strip('\x00')

            line = 'rcon %s "%s" %s\n' % (challenge, password, command)
            raw = _ask(sock, addr, line.encode('utf-8'), timeout)
            out = raw.decode('utf-8', 'replace').lstrip('l').strip('\x00').strip()

            if 'Bad rcon_password' in out:
                raise RconError('неверный rcon_password')
            return out
        except socket.timeout:
            last = RconError('сервер не ответил за %.0f с' % timeout)
        except RconError as e:
            last = e
            if 'rcon_password' in str(e):
                break
        finally:
            sock.close()

    raise last or RconError('не вышло')


def info(ip, port, timeout=3.0):
    """A2S_INFO: имя сервера, карта, сколько игроков. Возвращает dict или None."""
    addr = (ip, int(port))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(timeout)
        req = HEADER + b'TSource Engine Query\x00'
        sock.sendto(req, addr)
        data, _ = sock.recvfrom(8192)

        # некоторые сборки отвечают челленджем 'A' — повторяем запрос с ним
        if len(data) > 4 and data[4:5] == b'A':
            sock.sendto(req + data[5:9], addr)
            data, _ = sock.recvfrom(8192)

        if len(data) < 6:
            return None
        body = data[5:]

        def cstr(buf):
            i = buf.index(b'\x00')
            return buf[:i].decode('utf-8', 'replace'), buf[i + 1:]

        name, body = cstr(body)
        mapname, body = cstr(body)
        _folder, body = cstr(body)
        _game, body = cstr(body)
        if len(body) < 5:
            return None
        players = body[2]
        maxplayers = body[3]
        return {'name': name, 'map': mapname, 'players': players, 'max': maxplayers}
    except (socket.timeout, ValueError, IndexError):
        return None
    finally:
        sock.close()
