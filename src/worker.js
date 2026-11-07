// cant.chat — сервер.
// Его единственная задача: свести двух людей в одной комнате и пересылать
// между ними уже зашифрованные сообщения. Он ничего не хранит, не пишет логов
// и не может прочитать ни одного сообщения: ключ живёт только в ссылке после «#»,
// а эту часть ссылки браузер никогда не отправляет на сервер.
// Звонки и файлы по возможности идут вообще напрямую, браузер↔браузер.
//
// Что сервер всё-таки видит (и это честно написано на сайте): IP-адреса,
// идентификатор комнаты (хеш ключа, по нему ключ не восстановить), время
// подключения и размер зашифрованных пакетов. Содержимое — никогда.

import { DurableObject } from "cloudflare:workers";

const MAX_PEERS = 2;
const MAX_FRAME = 256 * 1024;
const ROOM_PATH = /^\/ws\/([a-f0-9]{40})$/;
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

// TURN: временные доступы выдаются только внутри комнаты, где уже двое,
// не чаще раза в полчаса на человека и не больше ICE_MAX_PER_SOCKET за соединение.
// Раньше был открытый /ice — любой мог получать TURN за счёт владельца. Теперь нет.
const ICE_TTL_S = 2 * 3600;
const ICE_MIN_GAP_MS = 25 * 60 * 1000;
const ICE_MAX_PER_SOCKET = 4;

// Записки — единственное, что сервер хранит: зашифрованный блок (ключ — из кода, его у сервера нет)
// не дольше NOTE_MAX_TTL_S, удаляется при первом открытии или по сроку, что раньше.
const NOTE_PATH = /^\/note\/([a-f0-9]{40})$/;
const NOTE_MAX_CT = 1_900_000; // символов шифра (≈ текст + фото до 1 МБ); лимит значения в хранилище — 2 МиБ
const NOTE_MAX_TTL_S = 7 * 24 * 3600;
const NOTE_MIN_TTL_S = 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const match = url.pathname.match(ROOM_PATH);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      // Пускаем только со своего же сайта, чтобы чужие сайты не использовали наш сервер.
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) {
        return new Response("Forbidden", { status: 403 });
      }
      // Ограничение частоты: не больше N новых соединений в минуту с одного адреса.
      // Если привязка LIMITER отсутствует (старый wrangler) — просто пропускаем.
      if (!(await allow(env, "ws:" + clientIp(request)))) {
        return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "60" } });
      }
      const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
      return room.fetch(request);
    }

    // Записки: PUT — оставить, POST — открыть (и удалить).
    const note = url.pathname.match(NOTE_PATH);
    if (note) {
      if (request.method !== "PUT" && request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!sameSite(request, url)) return new Response("Forbidden", { status: 403 });
      const kind = request.method === "PUT" ? "note-put" : "note-open";
      if (!(await allow(env, `${kind}:${clientIp(request)}`))) {
        return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "60" } });
      }
      const obj = env.NOTES.get(env.NOTES.idFromName(note[1]));
      return obj.fetch(request);
    }

    // Старый открытый эндпоинт больше ничего не выдаёт.
    if (url.pathname === "/ice") return new Response("Gone", { status: 410 });


    return env.ASSETS.fetch(request);
  },
};

// Запросы к записке принимаем только со своего сайта (браузер всегда шлёт Origin для PUT/POST).
function sameSite(request, url) {
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

async function allow(env, key) {
  try {
    if (!env.LIMITER) return true;
    const { success } = await env.LIMITER.limit({ key });
    return success;
  } catch {
    return true;
  }
}

// Адреса для прямого соединения. Если настроен Cloudflare TURN (см. README),
// выдаём временные учётные данные: тогда звонки работают даже за строгими роутерами,
// а режим «скрыть мой IP» становится доступен.
async function iceServers(env) {
  if (!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN)) return { iceServers: STUN, relay: false };
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: ICE_TTL_S }),
      },
    );
    if (!r.ok) return { iceServers: STUN, relay: false };
    const data = await r.json();
    const list = (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers])
      .filter((s) => s && s.urls)
      .map((s) => {
        // Порт 53 браузеры блокируют, он только замедляет соединение.
        const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53\b/.test(u));
        return { ...s, urls };
      })
      .filter((s) => s.urls.length);
    const relay = list.some((s) => s.urls.some((u) => /^turns?:/.test(u)));
    return { iceServers: STUN.concat(list), relay, ttl: ICE_TTL_S };
  } catch {
    return { iceServers: STUN, relay: false };
  }
}

// Одна комната = один объект в памяти. Когда из него уходят все, он исчезает сам.
// Мы ничего не пишем в хранилище (this.ctx.storage не используется вообще).
export class Room extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const url = new URL(request.url);
    const wanted = url.searchParams.get("r");
    const token = url.searchParams.get("t") || "";
    let others = this.live();

    // Человек вернулся после обрыва связи, а его старое соединение ещё «висит» —
    // тихо заменяем старое новым, не пугая собеседника. Но только если он знает
    // секретный токен своего прошлого соединения: иначе любой, у кого есть ссылка,
    // мог бы выкинуть хозяина из комнаты.
    let resumed = false;
    if ((wanted === "host" || wanted === "guest") && token) {
      const stale = others.find((s) => {
        const a = s.deserializeAttachment();
        return a?.role === wanted && a?.token === token;
      });
      if (stale) {
        stale.serializeAttachment({ ...stale.deserializeAttachment(), replaced: true });
        safeClose(stale, 4004, "replaced");
        others = others.filter((s) => s !== stale);
        resumed = true;
      }
    }
    const taken = new Set(others.map((s) => s.deserializeAttachment()?.role));

    if (others.length >= MAX_PEERS) {
      server.accept();
      server.send(JSON.stringify({ sys: "full" }));
      server.close(4001, "full");
      return new Response(null, { status: 101, webSocket: client });
    }

    let role = wanted === "host" || wanted === "guest" ? wanted : null;
    if (!role || taken.has(role)) role = taken.has("host") ? "guest" : "host";
    const myToken = resumed ? token : newToken();

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, token: myToken, iceN: 0, iceAt: 0 });
    server.send(JSON.stringify({ sys: "hello", role, token: myToken, peers: others.length, resumed }));
    this.broadcast(server, JSON.stringify({ sys: "peer-join" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_FRAME) return;

    // Служебные команды начинаются с {"cmd": — всё остальное пересылаем как есть.
    if (message.startsWith('{"cmd"')) {
      let cmd;
      try {
        cmd = JSON.parse(message).cmd;
      } catch {
        return;
      }
      const att = ws.deserializeAttachment() || {};
      if (cmd === "kick" && att.role === "host") {
        for (const other of this.ctx.getWebSockets()) {
          if (other !== ws) safeClose(other, 4002, "kicked");
        }
      } else if (cmd === "burn") {
        for (const other of this.ctx.getWebSockets()) safeClose(other, 4003, "burned");
      } else if (cmd === "leave") {
        this.broadcast(ws, JSON.stringify({ sys: "peer-bye" }));
        safeClose(ws, 1000, "leave");
      } else if (cmd === "ice") {
        await this.giveIce(ws, att);
      }
      return;
    }

    this.broadcast(ws, message);
  }

  // Выдаём адреса для прямого соединения (и TURN, если настроен).
  async giveIce(ws, att) {
    const now = Date.now();
    const twoHere = this.live().length >= MAX_PEERS;
    const tooMany = (att.iceN || 0) >= ICE_MAX_PER_SOCKET;
    const tooSoon = att.iceAt && now - att.iceAt < ICE_MIN_GAP_MS;
    if (!twoHere || tooMany || tooSoon) {
      // Без TURN, только публичные STUN: звонок всё равно попробует соединиться.
      try { ws.send(JSON.stringify({ sys: "ice", iceServers: STUN, relay: false })); } catch { /* ушёл */ }
      return;
    }
    ws.serializeAttachment({ ...att, iceN: (att.iceN || 0) + 1, iceAt: now });
    const ice = await iceServers(this.env);
    // HIDE_IP_DEFAULT=off в настройках воркера выключает «скрыть мой IP» по умолчанию
    // (пользователь всё равно может включить его в меню комнаты).
    const hideIpDefault = String(this.env.HIDE_IP_DEFAULT || "").toLowerCase() !== "off";
    try { ws.send(JSON.stringify({ sys: "ice", ...ice, hideIpDefault })); } catch { /* ушёл */ }
  }

  async webSocketClose(ws) {
    const replaced = ws.deserializeAttachment()?.replaced;
    safeClose(ws, 1000, "bye");
    if (!replaced) this.broadcast(ws, JSON.stringify({ sys: "peer-left" }));
  }

  async webSocketError(ws) {
    const replaced = ws.deserializeAttachment()?.replaced;
    safeClose(ws, 1011, "error");
    if (!replaced) this.broadcast(ws, JSON.stringify({ sys: "peer-left" }));
  }

  live() {
    return this.ctx.getWebSockets().filter((s) => !s.deserializeAttachment()?.replaced);
  }

  broadcast(from, message) {
    for (const other of this.live()) {
      if (other === from) continue;
      try {
        other.send(message);
      } catch {
        // собеседник уже отключился — ничего страшного
      }
    }
  }
}

// Одна записка = один объект. Хранит ровно одно значение: шифр и срок. Будильник удаляет по сроку.
export class Note extends DurableObject {
  async fetch(request) {
    const now = Date.now();
    const cur = await this.ctx.storage.get("note");
    const alive = cur && cur.exp > now;

    if (request.method === "PUT") {
      if (alive) return Response.json({ error: "taken" }, { status: 409 });
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "bad" }, { status: 400 });
      }
      const ct = typeof body?.ct === "string" ? body.ct : "";
      const ttl = Math.floor(Number(body?.ttl));
      if (!ct || ct.length > NOTE_MAX_CT || !/^[A-Za-z0-9_-]+$/.test(ct)) return Response.json({ error: "bad" }, { status: 400 });
      if (!(ttl >= NOTE_MIN_TTL_S && ttl <= NOTE_MAX_TTL_S)) return Response.json({ error: "bad" }, { status: 400 });
      const exp = now + ttl * 1000;
      await this.ctx.storage.put("note", { ct, exp });
      await this.ctx.storage.setAlarm(exp);
      return Response.json({ ok: true, exp }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }

    // POST: открыть. Первое открытие — единственное: запись удаляется сразу.
    if (!alive) {
      if (cur) await this.ctx.storage.deleteAll();
      return Response.json({ error: "none" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    await this.ctx.storage.deleteAll();
    return Response.json({ ct: cur.ct }, { headers: { "Cache-Control": "no-store" } });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function safeClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // уже закрыт
  }
}
