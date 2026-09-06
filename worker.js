/**
 * Чёрный Рассвет — бот на Cloudflare Workers.
 *
 * Три входа:
 *   POST /tg            — вебхук Telegram, отвечает мгновенно
 *   GET  /da/login      — начать привязку DonationAlerts (один раз)
 *   GET  /da/callback   — сюда DonationAlerts возвращает код
 * И крон раз в минуту: забирает новые донаты и выдаёт привилегии.
 *
 * Команды серверу уходят через API панели по HTTPS: RCON здесь недоступен,
 * потому что воркеры не умеют UDP.
 */

const DA = 'https://www.donationalerts.com';
const SCOPES = 'oauth-user-show oauth-donation-index oauth-donation-subscribe';

/* ------------------------------------------------------------------ утилиты */

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function admins(env) {
  return String(env.TG_ADMINS || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number);
}

function isAdmin(env, id) {
  return admins(env).includes(Number(id));
}

function adminChat(env) {
  return admins(env)[0];
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}

const say = (env, chat, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

async function getJson(env, key, def) {
  const v = await env.STATE.get(key, 'json');
  return v === null || v === undefined ? def : v;
}

const putJson = (env, key, val) => env.STATE.put(key, JSON.stringify(val));

/* ---------------------------------------------------------- разбор доната */

const STEAM_RE = /STEAM_[0-5]:[01]:\d+/i;
const STEAM_LOOSE = /STEAM[\s_]*([0-5])[\s:_]+([01])[\s:_]+(\d+)/i;

function findSteamId(text) {
  if (!text) return null;
  const m = STEAM_RE.exec(text);
  if (m) return m[0].toUpperCase();
  const l = STEAM_LOOSE.exec(text);
  return l ? `STEAM_${l[1]}:${l[2]}:${l[3]}` : null;
}

function priceList(env) {
  const parse = (raw) => {
    const p = String(raw || '').split('|').map((x) => x.trim());
    if (p.length < 4) return null;
    return { kind: p[0], days: Number(p[1]), price: Number(p[2]), currency: p[3].toUpperCase() };
  };
  return {
    vip_month: parse(env.PRICE_VIP_MONTH),
    vip_forever: parse(env.PRICE_VIP_FOREVER),
    admin_month: parse(env.PRICE_ADMIN_MONTH),
    admin_forever: parse(env.PRICE_ADMIN_FOREVER),
  };
}

function firstHit(low, words) {
  let best = null;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (best === null || i < best)) best = i;
  }
  return best;
}

/** Что человек заказал. Тип и срок ищем по отдельности, чтобы «админка
 *  навсегда» не превращалась в месячную из-за слитного написания. */
function matchItem(env, text) {
  const low = String(text || '').toLowerCase();
  const words = (v, d) => String(v || d).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

  const vi = firstHit(low, words(env.WORDS_VIP, 'вип,vip'));
  const ai = firstHit(low, words(env.WORDS_ADMIN, 'админ,admin'));
  if (vi === null && ai === null) return null;

  let kind;
  if (ai === null) kind = 'vip';
  else if (vi === null) kind = 'admin';
  else kind = vi < ai ? 'vip' : 'admin';

  const forever = firstHit(low, words(env.WORDS_FOREVER, 'навсегда,forever')) !== null;
  const item = priceList(env)[`${kind}_${forever ? 'forever' : 'month'}`];
  return item ? { ...item, key: `${kind}_${forever ? 'forever' : 'month'}` } : null;
}

function titleOf(item) {
  const base = item.kind === 'vip' ? 'VIP' : 'Админка';
  return base + (item.days === 0 ? ' навсегда' : ` на ${item.days} дн.`);
}

function priceOk(item, amount, currency) {
  if (!item || !(item.price > 0)) return true;
  if (currency && item.currency && String(currency).toUpperCase() !== item.currency) return false;
  const a = Number(amount);
  return Number.isFinite(a) && a + 0.001 >= item.price;
}

/* ------------------------------------------------------------ игровой сервер */

/** Отправить команду серверу через API панели. Панель отвечает 204 и
 *  ничего не возвращает, поэтому «успех» здесь значит только «принято». */
async function serverCommand(env, command) {
  const url = `${env.PANEL_URL}/api/client/servers/${env.PANEL_SERVER}/command`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PANEL_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ command }),
  });
  return { ok: r.status === 204 || r.ok, status: r.status };
}

/** Прочитать файл сервера через панель — нужно, чтобы проверить выдачу. */
async function serverFile(env, path) {
  const url = `${env.PANEL_URL}/api/client/servers/${env.PANEL_SERVER}/files/contents?file=${encodeURIComponent(path)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.PANEL_KEY}`, Accept: 'application/json' } });
  return r.ok ? r.text() : null;
}

/** Выдать привилегию и, если получится, убедиться, что она записалась. */
async function grant(env, kind, steamid, days) {
  const cmd = kind === 'admin'
    ? `zma_admin "${steamid}" ${days}`
    : `zma_vip "${steamid}" ${days}`;

  const res = await serverCommand(env, cmd);
  if (!res.ok) return { ok: false, why: `панель не приняла команду (код ${res.status})` };

  if (kind !== 'vip') return { ok: true, verified: false };

  // VIP пишется в файл — подождём и проверим, что SteamID там появился
  await new Promise((r) => setTimeout(r, 2500));
  const txt = await serverFile(env, '/cstrike/addons/amxmodx/data/zm_vip.ini');
  return { ok: true, verified: !!(txt && txt.includes(steamid)) };
}

/* ---------------------------------------------------------- DonationAlerts */

async function daTokens(env) {
  return getJson(env, 'da_tokens', null);
}

async function daRefresh(env, t) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: env.DA_CLIENT_ID,
    client_secret: env.DA_CLIENT_SECRET,
    scope: SCOPES,
  });
  const r = await fetch(`${DA}/oauth/token`, { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error('обновление токена не удалось');
  const fresh = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120000,
  };
  await putJson(env, 'da_tokens', fresh);
  return fresh;
}

async function daToken(env) {
  let t = await daTokens(env);
  if (!t) throw new Error('DonationAlerts не привязан');
  if (Date.now() >= (t.expires_at || 0)) t = await daRefresh(env, t);
  return t.access_token;
}

async function daGet(env, path) {
  const r = await fetch(DA + path, {
    headers: { Authorization: `Bearer ${await daToken(env)}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`DonationAlerts ответил ${r.status}`);
  return r.json();
}

/* -------------------------------------------------------- обработка донатов */

async function handleDonation(env, d) {
  const done = await getJson(env, 'done', []);
  if (d.id == null || done.includes(d.id)) return false;

  done.push(d.id);
  await putJson(env, 'done', done.slice(-300));

  const head =
    `<b>Донат</b> ${esc(d.amount)} ${esc(d.currency)} от <b>${esc(d.username || 'аноним')}</b>\n` +
    `<i>${esc(d.message) || '— без сообщения —'}</i>`;

  const steamid = findSteamId(d.message);
  const item = matchItem(env, d.message);

  const park = async (why) => {
    const pending = await getJson(env, 'pending', []);
    pending.push({ id: d.id, username: d.username, amount: d.amount, currency: d.currency,
                   message: d.message, why, at: Math.floor(Date.now() / 1000) });
    await putJson(env, 'pending', pending.slice(-50));
    await say(env, adminChat(env),
      `${head}\n\n⚠️ <b>Нужен ты:</b> ${esc(why)}.\nВ очереди номер <b>${pending.length}</b>.\n` +
      `Выдать руками: <code>/vip STEAM_0:1:… 30</code>\nУбрать: <code>/done ${pending.length}</code>`);
  };

  if (!item || !steamid) {
    const why = [];
    if (!item) why.push('не понял, что берут');
    if (!steamid) why.push('нет SteamID');
    await park(why.join(', '));
    return true;
  }

  if (!priceOk(item, d.amount, d.currency)) {
    await park(`сумма меньше цены «${titleOf(item)}»`);
    return true;
  }

  const g = await grant(env, item.kind, steamid, item.days);
  if (!g.ok) {
    await park(g.why);
    return true;
  }

  await say(env, adminChat(env),
    `${head}\n\n✅ Выдано: <b>${esc(titleOf(item))}</b>\nSteamID: <code>${esc(steamid)}</code>` +
    (item.kind === 'vip' ? (g.verified ? '\nЗапись в файле есть.' : '\n⚠️ В файле пока не вижу — проверь.') : ''));
  return true;
}

async function pollDonations(env) {
  const j = await daGet(env, '/api/v1/alerts/donations');
  const list = (j.data || []).slice().reverse();

  /* Первый запуск. Всё, что пришло до подключения бота, помечаем
     обработанным и ничего по нему не выдаём: иначе бот раздал бы
     привилегии по всей старой истории донатов. */
  const seeded = await env.STATE.get('seeded');
  if (!seeded) {
    const ids = list.map((d) => d.id).filter((x) => x !== null && x !== undefined);
    await putJson(env, 'done', ids.slice(-300));
    await env.STATE.put('seeded', String(Date.now()));
    await say(env, adminChat(env),
      `🟢 Бот подключён и слушает донаты.\nВ истории было ${ids.length} — они помечены как старые, ` +
      `выдаваться по ним ничего не будет. Новые обрабатываю сразу.`);
    return;
  }

  for (const d of list) await handleDonation(env, d);
}

/* ---------------------------------------------------------------- Telegram */

const HELP_USER =
  '<b>Чёрный Рассвет</b>\n\n' +
  '/online — кто сейчас на сервере\n' +
  '/top — пятнадцать первых по убийствам\n' +
  '/rank ник — место игрока\n' +
  '/ip — адрес сервера\n\n' +
  'Жалоба или спорный бан — напиши сюда текстом: свой ник, ник нарушителя, ' +
  'карту и примерное время. Передам администрации.';

const HELP_ADMIN =
  '\n\n<b>Для администрации</b>\n' +
  '/vip STEAM_0:1:… дней — выдать VIP (0 = навсегда)\n' +
  '/admin STEAM_0:1:… дней — выдать админку\n' +
  '/pending — неразобранные донаты\n' +
  '/done N — убрать из очереди\n' +
  '/cmd команда — выполнить команду на сервере';

const fmt = (n) => (n === null || n === undefined || isNaN(n) ? '—' : Math.round(n).toLocaleString('ru-RU'));

async function siteJson(url) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 30 } });
    return r.ok ? r.json() : null;
  } catch (e) {
    return null;
  }
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() / 1000 - ts) / 60);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  return `${Math.floor(m / 60)} ч назад`;
}

async function cmdOnline(env, chat) {
  const j = await siteJson(env.ONLINE_URL);
  if (!j) return say(env, chat, 'Не получилось прочитать сводку по серверу.');
  if (j.online === false) return say(env, chat, 'Сервер не отвечает.');
  const names = (j.list || []).map((p) => esc(p.name)).join(', ');
  return say(env, chat,
    `<b>На сервере ${j.players} из ${j.max}</b>\nКарта: <code>${esc(j.map)}</code>\n` +
    (names ? `\n${names}\n` : '') +
    `\n<i>сводка ${ago(j.updated)}</i>`);
}

async function cmdTop(env, chat) {
  const j = await siteJson(env.TOP_URL);
  const pl = (j && j.players) || [];
  if (!pl.length) return say(env, chat, 'Топ пока пуст.');
  pl.sort((a, b) => (b.kills - a.kills) || (b.damage - a.damage));
  const lines = ['<b>Пятнадцать первых</b>'];
  pl.slice(0, 15).forEach((p, i) => lines.push(`${i + 1}. ${esc(p.name)} — <b>${fmt(p.kills)}</b>`));
  lines.push(`\n<i>${ago(j.updated)}</i>`);
  return say(env, chat, lines.join('\n'));
}

async function cmdRank(env, chat, nick) {
  if (!nick) return say(env, chat, 'Напиши ник: <code>/rank Вася</code>');
  const j = await siteJson(env.TOP_URL);
  const pl = (j && j.players) || [];
  if (!pl.length) return say(env, chat, 'Статистика недоступна.');
  pl.sort((a, b) => (b.kills - a.kills) || (b.damage - a.damage));
  const low = nick.toLowerCase();
  const i = pl.findIndex((p) => String(p.name || '').toLowerCase().includes(low));
  if (i < 0) return say(env, chat, 'Не нашёл такого игрока.');
  const p = pl[i];
  return say(env, chat,
    `<b>${esc(p.name)}</b>\nМесто: <b>${i + 1}</b> из ${pl.length}\n` +
    `Убийств: <b>${fmt(p.kills)}</b>\nУрона: ${fmt(p.damage)}`);
}

async function cmdGrant(env, chat, kind, args) {
  if (args.length < 2) return say(env, chat, `Формат: <code>/${kind} STEAM_0:1:12345 30</code> (0 = навсегда)`);
  const steamid = findSteamId(args[0]);
  if (!steamid) return say(env, chat, `Это не похоже на SteamID: <code>${esc(args[0])}</code>`);
  const days = parseInt(args[1], 10);
  if (!Number.isFinite(days)) return say(env, chat, 'Дни числом.');
  const g = await grant(env, kind, steamid, days);
  if (!g.ok) return say(env, chat, `❌ ${esc(g.why)}`);
  return say(env, chat,
    `✅ Команда ушла: <b>${kind === 'admin' ? 'админка' : 'VIP'}</b> на <code>${esc(steamid)}</code>` +
    (kind === 'vip' ? (g.verified ? '\nЗапись в файле есть.' : '\n⚠️ В файле пока не вижу.') : ''));
}

async function cmdPending(env, chat) {
  const p = await getJson(env, 'pending', []);
  if (!p.length) return say(env, chat, 'Очередь пуста.');
  const lines = ['<b>Неразобранные донаты</b>'];
  p.forEach((d, i) => lines.push(
    `${i + 1}. ${esc(d.amount)} ${esc(d.currency)} от ${esc(d.username)} — ${esc(d.why)}\n    <i>${esc(d.message || '').slice(0, 120)}</i>`));
  lines.push('\nУбрать: <code>/done N</code>');
  return say(env, chat, lines.join('\n'));
}

async function cmdDone(env, chat, args) {
  const p = await getJson(env, 'pending', []);
  const n = parseInt(args[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > p.length) return say(env, chat, 'Формат: <code>/done 1</code>');
  p.splice(n - 1, 1);
  await putJson(env, 'pending', p);
  return say(env, chat, `Убрал. Осталось: ${p.length}`);
}

async function onMessage(env, m) {
  const text = (m.text || '').trim();
  const chat = m.chat && m.chat.id;
  const from = m.from || {};
  if (!chat || !text) return;

  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const args = text.split(/\s+/).slice(1);
  const adm = isAdmin(env, from.id);

  if (cmd === '/start' || cmd === '/help') return say(env, chat, HELP_USER + (adm ? HELP_ADMIN : ''));
  if (cmd === '/ip') {
    const a = `${env.SERVER_IP}:${env.SERVER_PORT}`;
    return say(env, chat, `Адрес сервера:\n<code>${a}</code>\n\nВ консоли игры:\n<code>connect ${a}</code>`);
  }
  if (cmd === '/online') return cmdOnline(env, chat);
  if (cmd === '/top') return cmdTop(env, chat);
  if (cmd === '/rank') return cmdRank(env, chat, args.join(' '));

  if (adm) {
    if (cmd === '/vip' || cmd === '/admin') return cmdGrant(env, chat, cmd.slice(1), args);
    if (cmd === '/pending') return cmdPending(env, chat);
    if (cmd === '/done') return cmdDone(env, chat, args);
    if (cmd === '/cmd') {
      if (!args.length) return say(env, chat, 'Например: <code>/cmd status</code>');
      const r = await serverCommand(env, args.join(' '));
      return say(env, chat, r.ok ? '✅ Команда отправлена. Ответ сервера панель не возвращает.' : `❌ код ${r.status}`);
    }
  }

  // всё остальное — жалоба
  const who = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'без имени';
  const tag = from.username ? '@' + from.username : 'без ника';
  await say(env, adminChat(env),
    `<b>Сообщение от игрока</b>\n${esc(who)} (${esc(tag)}, id <code>${from.id}</code>)\n\n${esc(text)}`);
  return say(env, chat, 'Передал администрации. Ответят здесь же.');
}

/* -------------------------------------------------------------------- вход */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/tg' && request.method === 'POST') {
      if (env.TG_WEBHOOK_SECRET &&
          request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
        return new Response('no', { status: 403 });
      }
      const upd = await request.json().catch(() => ({}));
      if (upd.message) ctx.waitUntil(onMessage(env, upd.message).catch(() => {}));
      return new Response('ok');
    }

    // Служебные страницы. Ключ SETUP_KEY защищает их от посторонних.
    if (url.pathname === '/setup/status') {
      if (url.searchParams.get('key') !== env.SETUP_KEY) return new Response('no', { status: 403 });
      const have = (v) => (v ? 'есть' : 'НЕТ');
      const t = await daTokens(env);
      const lines = [
        'TG_TOKEN: ' + have(env.TG_TOKEN),
        'PANEL_KEY: ' + have(env.PANEL_KEY),
        'DA_CLIENT_ID: ' + have(env.DA_CLIENT_ID),
        'DA_CLIENT_SECRET: ' + have(env.DA_CLIENT_SECRET),
        'TG_ADMINS: ' + (env.TG_ADMINS || 'НЕТ'),
        'DonationAlerts привязан: ' + have(t),
        'KV STATE: ' + have(env.STATE),
        '',
        'Вебхук телеграма: ' + url.origin + '/tg',
        'Привязать донаты: ' + url.origin + '/da/login?key=…',
      ];
      return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Подключить вебхук телеграма, не светя токен в адресной строке.
    if (url.pathname === '/setup/webhook') {
      if (url.searchParams.get('key') !== env.SETUP_KEY) return new Response('no', { status: 403 });
      const j = await tg(env, 'setWebhook', {
        url: `${url.origin}/tg`,
        secret_token: env.TG_WEBHOOK_SECRET,
        allowed_updates: ['message'],
      });
      return new Response(JSON.stringify(j, null, 1), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // Привязка DonationAlerts. Ссылку открываешь один раз, в браузере.
    if (url.pathname === '/da/login') {
      if (url.searchParams.get('key') !== env.SETUP_KEY) return new Response('no', { status: 403 });
      const redirect = `${url.origin}/da/callback`;
      const auth = `${DA}/oauth/authorize?` + new URLSearchParams({
        client_id: env.DA_CLIENT_ID, redirect_uri: redirect,
        response_type: 'code', scope: SCOPES,
      });
      return Response.redirect(auth, 302);
    }

    if (url.pathname === '/da/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('нет кода', { status: 400 });
      const body = new URLSearchParams({
        grant_type: 'authorization_code', client_id: env.DA_CLIENT_ID,
        client_secret: env.DA_CLIENT_SECRET, redirect_uri: `${url.origin}/da/callback`, code,
      });
      const j = await (await fetch(`${DA}/oauth/token`, { method: 'POST', body })).json();
      if (!j.access_token) return new Response('DonationAlerts не выдал токен', { status: 400 });
      await putJson(env, 'da_tokens', {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120000,
      });
      return new Response('Готово. DonationAlerts привязан, вкладку можно закрыть.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response('blackdawn bot', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollDonations(env).catch(async (e) => {
      // о поломке узнаём сразу, а не когда игрок пожалуется
      const last = await env.STATE.get('last_error_at');
      const now = Date.now();
      if (!last || now - Number(last) > 3600000) {
        await env.STATE.put('last_error_at', String(now));
        await say(env, adminChat(env), `⚠️ Донаты не читаются: ${esc(e.message || e)}`);
      }
    }));
  },
};
