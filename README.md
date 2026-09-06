# Бот сервера «Чёрный Рассвет»

Телеграм-бот и автовыдача привилегий для зомби-сервера CS 1.6
`195.60.166.224:27374`.

Что делает:

- слушает донаты DonationAlerts по вебсокету и сразу выдаёт VIP или админку
  на игровом сервере по SteamID из сообщения к платежу;
- не разобрал донат — не гадает, а кладёт в очередь и зовёт администратора
  в Telegram;
- отвечает игрокам: `/online`, `/top`, `/rank ник`, `/ip`;
- принимает жалобы и пересылает их администрации.

## Установка

Пошагово, с нуля и без опыта администрирования — в файле
[УСТАНОВКА.md](УСТАНОВКА.md).

Коротко, если сервер уже есть:

```
git clone https://github.com/cherniirassvet/blackdawn-bot.git bot
cd bot
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp config.example.ini config.ini
nano config.ini            # токены и пароли
./venv/bin/python3 setup_da.py    # один раз, привязать DonationAlerts
./venv/bin/python3 bot.py         # проверить
```

Автозапуск:

```
sudo cp blackdawn-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blackdawn-bot
```

## Обновление

```
cd ~/bot && git pull && sudo systemctl restart blackdawn-bot
```

`config.ini` и `state.json` в репозиторий не попадают — они в `.gitignore`.
Ни токенов, ни паролей здесь нет и быть не должно.

## Что где лежит

| Файл | Зачем |
| --- | --- |
| `bot.py` | Бот целиком: Telegram, DonationAlerts, выдача привилегий |
| `rcon.py` | Протокол RCON и запрос статуса сервера GoldSrc, без библиотек |
| `shop.py` | Разбор сообщения к донату: что купили и на какой SteamID |
| `setup_da.py` | Одноразовая привязка аккаунта DonationAlerts |
| `config.example.ini` | Образец настроек, скопировать в `config.ini` |
| `blackdawn-bot.service` | Юнит systemd для автозапуска |

## Что должен написать донатер

Чтобы выдача сработала сама, в сообщении к платежу нужны позиция и SteamID:

```
VIP STEAM_0:1:12345678
админка навсегда STEAM_0:1:12345678
```

Ошибся — бот молча ничего не выдаст, а пришлёт донат администратору с
пометкой, что не так.
