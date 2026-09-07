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

/* Телеграм иногда доставляет одно и то же обновление дважды - тогда бот
   отвечает два раза подряд. Помним номера последних в памяти воркера:
   это бесплатно, в отличие от записи в KV. */
const seenUpdates = new Set();

/* Своё имя нужно, чтобы в общем чате не хватать /online@ЧужойБот.
   Спрашиваем один раз на воркер и запоминаем. */
let botUser = null;

async function myUsername(env) {
  if (botUser !== null) return botUser;
  const j = await tg(env, 'getMe', {});
  botUser = String(((j || {}).result || {}).username || '').toLowerCase();
  return botUser;
}

function firstTime(id) {
  if (id === undefined || id === null) return true;
  if (seenUpdates.has(id)) return false;
  seenUpdates.add(id);
  if (seenUpdates.size > 500) seenUpdates.delete(seenUpdates.values().next().value);
  return true;
}

/* ---------------------------------------------------------------- Telegram */

const HELP_USER =
  '<b>Чёрный Рассвет</b>\n\n' +
  '/online — кто сейчас на сервере\n' +
  '/top — пятнадцать первых по убийствам\n' +
  '/clans — топ кланов\n' +
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

/* «1 фраг, 2 фрага, 5 фрагов» — иначе список читается коряво. */
function plural(n, one, few, many) {
  const a = Math.abs(Math.round(n)) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/* Первая тройка - медалями, дальше просто номер. */
function place(i) {
  return ['\u{1F947}', '\u{1F948}', '\u{1F949}'][i] || `${i + 1}.`;
}

/* Урон крупными числами читать невозможно: 30 421 877 -> 30.42M */
function big(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  return fmt(v);
}

/* Название сервера в шапках. Меняется переменной SERVER_NAME. */
function serverName(env) {
  return (env && env.SERVER_NAME) || '\u0427\u0451\u0440\u043D\u044B\u0439 \u0420\u0430\u0441\u0441\u0432\u0435\u0442';
}

/* Время сводки в часовом поясе сервера. Пояс меняется переменной TZ. */
function clock(ts, env) {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleTimeString('ru-RU',
      { timeZone: (env && env.TZ) || 'Europe/Moscow', hour12: false });
  } catch (e) {
    return new Date(ts * 1000).toISOString().slice(11, 19);
  }
}

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

/* ------------------------------------------- живые данные с сервера

   Файлы игрового сервера бот читает через панель прямо в момент запроса.
   Раньше цифры шли с сайта, а их робот обновляет раз в 15 минут - отсюда
   и брались устаревшие ответы. Если панель молчит, откатываемся на файлы
   сайта, чтобы бот не остался вовсе без данных. */

const SRV = '/cstrike/addons/amxmodx/data/';

/* Верхняя половина CP1251: старые ники приходят в ней, а не в UTF-8. */
const CP1251_HI = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

function decodeBytes(u8) {
  if (!u8) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (e) {
    let out = '';
    for (let i = 0; i < u8.length; i++) {
      const b = u8[i];
      out += b < 0x80 ? String.fromCharCode(b) : CP1251_HI[b - 0x80];
    }
    return out;
  }
}

async function panelBytes(env, path) {
  try {
    const url = `${env.PANEL_URL}/api/client/servers/${env.PANEL_SERVER}`
      + `/files/contents?file=${encodeURIComponent(path)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.PANEL_KEY}`, Accept: 'application/json' } });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    return null;
  }
}

/* Значения в ini бывают в кавычках, а название клана - с пробелами. */
const tokens = (line) => (line.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));

const iniRows = (text) => String(text || '').split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !';#[/'.includes(l[0]));

/* Строка: название тег уровень опыт монеты банк слоты STEAM_лидера победы поражения ...
   Опираемся на SteamID: от него пять чисел назад, перед ними тег. */
function parseClansIni(text) {
  const out = [];
  for (const line of iniRows(text)) {
    const t = tokens(line);
    const k = t.findIndex((v) => /^STEAM_/i.test(v));
    if (k < 6) continue;
    const num = (i) => { const v = parseInt(t[i], 10); return Number.isFinite(v) ? v : 0; };
    out.push({
      idx: out.length,
      name: t.slice(0, k - 6).join(' ').trim() || t[k - 6],
      tag: t[k - 6],
      level: num(k - 5), exp: num(k - 4), slots: num(k - 1),
      wins: num(k + 1), losses: num(k + 2),
      members: 0, leader: '',
    });
  }
  return out;
}

/* Строка: STEAM_игрока ник клан ранг ... Ранг 2 - глава. */
function fillRoster(clans, text) {
  for (const line of iniRows(text)) {
    const t = tokens(line);
    if (t.length < 4) continue;
    const c = clans[parseInt(t[2], 10)];
    if (!c) continue;
    c.members++;
    if (parseInt(t[3], 10) >= 2 && t[1]) c.leader = t[1];
  }
  return clans;
}

/* csstats.dat: по игроку - ник, SteamID и двадцать чисел.
   Начальное смещение у разных сборок AMXX разное, поэтому пробуем
   несколько и берём тот разбор, что дочитал файл до конца. */
function csstatsFrom(u8, dv, off) {
  const n = u8.length;
  let i = off;
  const out = [];
  const str = (len) => {
    let end = i;
    while (end < i + len && u8[end] !== 0) end++;
    const s = decodeBytes(u8.subarray(i, end)).trim();
    i += len;
    return s;
  };
  while (i + 2 <= n) {
    const ln = dv.getInt16(i, true); i += 2;
    if (ln <= 0 || ln > 128 || i + ln > n) break;
    const name = str(ln);
    if (i + 2 > n) break;
    const ls = dv.getInt16(i, true); i += 2;
    if (ls < 0 || ls > 128 || i + ls > n) break;
    str(ls);
    if (i + 80 > n) break;
    const v = (j) => dv.getInt32(i + j * 4, true);
    const row = { name, damage: Math.max(0, v(1)), deaths: Math.max(0, v(2)),
                  kills: Math.max(0, v(3)), hs: Math.max(0, v(6)) };
    i += 80;
    if (name) out.push(row);
  }
  return { rows: out, used: i };
}

function parseCsstats(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let best = [], bestScore = -1;
  for (const off of [2, 6, 4, 0, 8]) {
    let r;
    try { r = csstatsFrom(u8, dv, off); } catch (e) { continue; }
    if (!r.rows.length) continue;
    const tail = u8.length - r.used;
    const score = r.rows.length * 1000 - tail;
    if (tail <= 8 && score > bestScore) { best = r.rows; bestScore = score; }
  }
  return best;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function liveOnline(env) {
  const u8 = await panelBytes(env, SRV + 'zm_online.json');
  if (u8 && u8.length) {
    try {
      const j = JSON.parse(decodeBytes(u8));
      if (j && Array.isArray(j.list)) return j;
    } catch (e) { /* файла ещё нет или он пишется - берём запасной */ }
  }
  return siteJson(env.ONLINE_URL);
}

async function liveClans(env) {
  const c = await panelBytes(env, SRV + 'zm_clans.ini');
  if (!c) {
    const j = await siteJson(env.TOP_URL);
    return j ? { clans: j.clans || [], updated: j.updated } : null;
  }
  const clans = parseClansIni(decodeBytes(c));
  const m = await panelBytes(env, SRV + 'zm_clan_members.ini');
  if (m) fillRoster(clans, decodeBytes(m));
  return { clans, updated: nowSec() };
}

async function liveTop(env) {
  const u8 = await panelBytes(env, SRV + 'csstats.dat');
  if (!u8) {
    const j = await siteJson(env.TOP_URL);
    return j ? { players: j.players || [], updated: j.updated } : null;
  }
  return { players: parseCsstats(u8), updated: nowSec() };
}

async function cmdOnline(env, chat) {
  const j = await liveOnline(env);
  if (!j) return say(env, chat, 'Не получилось прочитать сводку по серверу.');
  if (j.online === false) return say(env, chat, '🔴 Сервер не отвечает.');

  const addr = `${env.SERVER_IP}:${env.SERVER_PORT}`;
  const max = j.max || 32;
  const pct = max ? Math.round((j.players / max) * 100) : 0;

  const list = (j.list || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const rows = list.map((p, i) => {
    const s = Number(p.score) || 0;
    return `${i + 1}. ${esc(p.name)} • ${fmt(s)} ${plural(s, 'фраг', 'фрага', 'фрагов')}`;
  });

  const out = [
    '👥 <b>Реальный онлайн</b>',
    '',
    `🌐 Адрес: <code>${addr}</code>`,
    `🗺️ Карта: <code>${esc(j.map) || '—'}</code>`,
    `👤 Онлайн: <b>${j.players}/${max}</b> (${pct}%)`,
  ];
  if (rows.length) out.push('', '👤 <b>Игроки:</b>', rows.join('\n'));
  out.push('', `🕒 Обновлено: ${clock(j.updated, env)}`);

  return say(env, chat, out.join('\n'));
}

async function cmdClans(env, chat) {
  const j = await liveClans(env);
  const cl = ((j && j.clans) || []).slice()
    .sort((a, b) => (b.exp - a.exp) || (b.level - a.level));
  if (!cl.length) return say(env, chat, 'Кланов пока нет. Создать можно в игре: меню на клавише M.');

  const blocks = cl.slice(0, 15).map((c, i) => {
    /* Строки, которых нет в данных, не рисуем - лучше короче, чем прочерк. */
    const det = [];
    if (c.leader) det.push(`🎩 Глава: ${esc(c.leader)}`);
    if (c.members !== undefined && c.members !== null) {
      det.push(`👥 Игроки: ${fmt(c.members)}/${fmt(c.slots || 0)}`);
    }
    det.push(`💎 Опыт: ${fmt(c.exp)}`);
    if (c.wins !== undefined || c.losses !== undefined) {
      det.push(`⚔️ Побед/Поражений: ${fmt(c.wins || 0)}/${fmt(c.losses || 0)}`);
    }
    const tree = det.map((t, k) => (k === det.length - 1 ? '└ ' : '├ ') + t);
    return `${place(i)} <b>${esc(c.name)}</b> [LVL: ${fmt(c.level)}]\n${tree.join('\n')}`;
  });

  return say(env, chat, [
    `🏆 <b>ТОП КЛАНОВ</b> ${esc(serverName(env))}`,
    '',
    blocks.join('\n\n'),
    '',
    `🕒 Обновлено: ${clock(j.updated, env)}`,
  ].join('\n'));
}

async function cmdTop(env, chat) {
  const j = await liveTop(env);
  const pl = ((j && j.players) || []).slice();
  if (!pl.length) return say(env, chat, 'Топ пока пуст.');
  pl.sort((a, b) => (b.kills - a.kills) || (b.damage - a.damage));

  const blocks = pl.slice(0, 15).map((p, i) =>
    `${place(i)} <b>${esc(p.name)}</b>\n└ Убито: ${fmt(p.kills)} | Урон: ${big(p.damage)}`);

  return say(env, chat, [
    '🏆 <b>ТОП-15 ИГРОКОВ СЕРВЕРА</b>',
    '',
    blocks.join('\n\n'),
    '',
    `🕒 Обновлено: ${clock(j.updated, env)}`,
  ].join('\n'));
}

async function cmdRank(env, chat, nick) {
  if (!nick) return say(env, chat, 'Напиши ник: <code>/rank Вася</code>');
  const j = await liveTop(env);
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

  /* Личка или общий чат - от этого зависит, что бот вообще слушает. */
  const priv = !m.chat || m.chat.type === 'private';

  const head = text.split(/\s+/)[0];
  const cmd = head.split('@')[0].toLowerCase();
  const at = head.includes('@') ? head.split('@')[1].toLowerCase() : '';
  const args = text.split(/\s+/).slice(1);
  const adm = isAdmin(env, from.id);

  /* В общем чате бот молчит на всё, кроме своих команд: пересказывать
     администрации каждое сообщение из чата - не дело. */
  if (!priv) {
    if (cmd[0] !== '/') return;
    if (at && at !== (await myUsername(env))) return;
  }

  if (cmd === '/start' || cmd === '/help') return say(env, chat, HELP_USER + (adm ? HELP_ADMIN : ''));
  if (cmd === '/ip') {
    const a = `${env.SERVER_IP}:${env.SERVER_PORT}`;
    return say(env, chat, `Адрес сервера:\n<code>${a}</code>\n\nВ консоли игры:\n<code>connect ${a}</code>`);
  }
  if (cmd === '/online') return cmdOnline(env, chat);
  if (cmd === '/top' || cmd === '/top15' || cmd === '/stats') return cmdTop(env, chat);
  if (cmd === '/clans' || cmd === '/clan' || cmd === '/topclans') return cmdClans(env, chat);
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

  // всё остальное — жалоба, и только из личной переписки
  if (!priv) return;

  /* Пересылать администратору его же сообщение незачем. */
  if (adm) return say(env, chat, 'Не понял команду. Список — /help.');

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

    /* Открытые сводки для сайта. Секретов тут нет - те же цифры, что
       бот показывает в телеграме, только сразу с сервера. Ответ кладём
       в кэш на 15 секунд, чтобы не дёргать панель на каждого гостя. */
    if (url.pathname === '/api/online' || url.pathname === '/api/top') {
      const cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;

      let body;
      if (url.pathname === '/api/online') {
        body = (await liveOnline(env)) || { online: false, players: 0, list: [] };
      } else {
        const [t, c] = await Promise.all([liveTop(env), liveClans(env)]);
        body = { players: (t && t.players) || [], clans: (c && c.clans) || [],
                 updated: (t && t.updated) || nowSec() };
      }
      const res = new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=15',
        },
      });
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }

    if (url.pathname === '/tg' && request.method === 'POST') {
      if (env.TG_WEBHOOK_SECRET &&
          request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
        return new Response('no', { status: 403 });
      }
      const upd = await request.json().catch(() => ({}));
      if (upd.message && firstTime(upd.update_id)) {
        ctx.waitUntil(onMessage(env, upd.message).catch(() => {}));
      }
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
      /* Заодно кладём список команд в меню Telegram. */
      const menu = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'online', description: 'Кто сейчас на сервере' },
          { command: 'top15',  description: 'Топ-15 игроков' },
          { command: 'clans',  description: 'Топ кланов' },
          { command: 'rank',   description: 'Место игрока по нику' },
          { command: 'ip',     description: 'Адрес сервера' },
          { command: 'help',   description: 'Что умеет бот' },
        ],
      });
      return new Response(JSON.stringify({ webhook: j, menu }, null, 1), {
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
