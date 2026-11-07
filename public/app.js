// cant.chat — логика в браузере.
// Всё хранится только в памяти этой вкладки и стирается при выходе.

import { STRINGS } from "./i18n.js";
import { roomName, emojiName } from "./words.js";
import {
  toB64u, fromB64u, randomBytes, roomIdFor, wrapKeyFor, seal, unseal,
  newIdentity, deriveSession, sameBytes, noteKeyFor, noteIdFor,
} from "./crypto.js";
import { qrSvg } from "./qr.js";
import { Peer } from "./rtc.js";
import { FileHub, sleep } from "./files.js";
import {
  FX_MODES, voicePipeline, getMic, getCam, cameraCount, canRecord, canShareScreen, startRecording, keepAwake,
} from "./media.js";
import { sounds, startRing, stopRing, unlockAudio } from "./sound.js";
import { normalizeCode, codeProblem, codeStrength, codeKey, CODE_TTL_MS, CODE_MIN, NOTE_CODE_MIN } from "./code.js";
import { safeMime } from "./files.js";

const $ = (id) => document.getElementById(id);
const LINK_RE = /^#([a-z]+-[a-z]+-\d{2})\.([A-Za-z0-9_-]{43})$/;
const TTLS = [0, 30, 300];
const TTL_LABEL = ["∞", "30s", "5m"];
const FLASH = [0, 3, 5, 10]; // секунды показа фото-вспышки
const GRACE_MS = 90_000; // сколько ждём собеседника после обрыва связи
const CALL_TIMEOUT = 45_000;
const BURN_HOLD_MS = 1150;
const STUN_FALLBACK = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const coarse = () => matchMedia("(pointer: coarse)").matches;
const newId = () => [...randomBytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi;

// ---------- язык ----------
let lang = "";
try {
  lang = localStorage.getItem("lang") || "";
} catch { /* ignore */ }
const LANGS = ["en", "sv", "ru"];
if (!STRINGS[lang]) {
  const nav = (navigator.language || "").toLowerCase().slice(0, 2);
  lang = STRINGS[nav] ? nav : "en";
}
const t = (k) => STRINGS[lang][k] ?? k;
const tf = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");

let S = null; // состояние текущей комнаты (только в памяти)
let fxMode = "off"; // эффект голоса для звонков и голосовых

function applyLang() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  $("input").placeholder = t("placeholder");
  $("codeInput").placeholder = t("codePlaceholder");
  $("cipherIn").placeholder = t("cipherPlaceholder");
  $("codeEdit").placeholder = t("codeEditPlaceholder");
  $("noteText").placeholder = t("notePlaceholder");
  $("noteCode").placeholder = t("noteCodePlaceholder");
  $("lang").textContent = lang.toUpperCase();
  document.documentElement.lang = lang;
  $("lang").setAttribute("aria-label", t("lang"));
  const titles = {
    audioCall: "callAudio", videoCall: "callVideo", attach: "attach", more: "more", send: "send", mic: "record",
    recCancel: "cancel", cMic: "mic", cCam: "cam", cFlip: "flip", cScreen: "screen", cFx: "fx", cEnd: "hangup", burn: "burnHint",
  };
  for (const [id, key] of Object.entries(titles)) {
    $(id).title = t(key);
    $(id).setAttribute("aria-label", t(key));
  }
  refreshMenu();
  if (S) {
    refreshStatus();
    renderEmojiRows();
    refreshVerify();
  }
}

$("qrBtn").onclick = () => {
  const open = $("qrWrap").classList.toggle("open");
  $("qrBtn").setAttribute("aria-expanded", String(open));
};

$("lang").onclick = () => {
  lang = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length];
  try { localStorage.setItem("lang", lang); } catch { /* ignore */ }
  applyLang();
};

// ---------- общие элементы интерфейса ----------
function show(view) {
  for (const v of ["home", "room", "note", "end"]) $(v).hidden = v !== view;
  document.body.classList.toggle("home", view === "home");
  document.body.classList.toggle("light", view === "note"); // записка — светлая сторона
  if (view !== "home") closeCipher();
}

function showPanel(name) {
  for (const p of ["sharePanel", "knockPanel", "waitPanel", "chat"]) $(p).hidden = p !== name;
  const inChat = name === "chat";
  $("audioCall").hidden = !inChat;
  $("videoCall").hidden = !inChat;
}

function setStatus(key) {
  if (!S) return;
  S.statusKey = key;
  refreshStatus();
}

function refreshStatus() {
  const k = S.statusKey;
  const secure = k === "secured";
  const both = secure && S.verified?.mine && S.verified?.theirs;
  let text = t(both ? "verified" : k);
  if (secure && S.peer?.open) text += " · " + t(S.pathKind === "relay" ? "viaRelay" : "direct");
  $("statusText").textContent = text;
  $("statusIcon").setAttribute("href", both ? "#i-shield" : k === "reconnecting" || k === "peerAway" || k === "hostAway" ? "#i-wifi-off" : "#i-lock");
  $("status").classList.toggle("secure", secure && !both);
  $("status").classList.toggle("verified", !!both);
}

function toast(text, ms = 2200) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => (el.hidden = true), ms);
}

function icon(name, cls = "ico") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

addEventListener("pointerdown", unlockAudio, { capture: true });
addEventListener("keydown", unlockAudio, { capture: true });

// ---------- главная ----------
$("create").onclick = () => {
  enterRoom({ name: roomName(), linkKey: randomBytes(32), creator: true });
};

$("again").onclick = () => {
  show("home");
  document.title = "cant.chat";
};

// =====================================================================
// Комната
// =====================================================================
async function enterRoom({ name, linkKey, creator }) {
  S = {
    name, linkKey, creator,
    link: `${location.origin}/#${name}.${toB64u(linkKey)}`,
    roomId: await roomIdFor(linkKey),
    wrapKey: await wrapKeyFor(linkKey),
    me: await newIdentity(),
    role: null, token: "", ws: null, admitted: false, ended: false, burning: false,
    ice: null, hideIp: hideIpPref(),
    peerPub: null, sessionKey: null, emoji: null,
    verified: { mine: false, theirs: false },
    sendN: 0, recvN: 0, sendQ: Promise.resolve(), recvQ: Promise.resolve(),
    outbox: [], peerPresent: false, lostAt: 0, retry: 0,
    timers: [], ttlIdx: 0, live: false, unseen: 0, unseenIds: [],
    msgs: new Map(), urls: new Set(), replyTo: null, flashIdx: 0, code: null,
    stats: { msgs: 0, files: 0, startedAt: 0 },
    peer: null, rtcPending: [], rtcEpoch: 0, pathKind: null, relayOnly: false,
    remoteStream: null, call: null, rec: null, files: null,
  };

  $("roomName").textContent = name;
  $("waitRoom").textContent = name;
  $("shareLink").value = S.link;
  $("qr").replaceChildren();
  try {
    $("qr").append(qrSvg(S.link));
  } catch { /* слишком длинная ссылка — без QR */ }
  $("messages").replaceChildren();
  $("ghost").hidden = true;
  $("typing").hidden = true;
  $("call").hidden = true;
  $("ring").hidden = true;
  $("moreMenu").hidden = true;
  $("verify").hidden = false;
  $("verifiedBar").hidden = true;
  $("verify").classList.remove("mine");
  setReply(null);
  disarmBurn();
  renderCode();
  refreshMenu();
  refreshComposer();
  renderEmojiRows();
  show("room");
  showPanel(null);
  setStatus("connecting");
  connect();
}

// ---------- соединение с сервером (с автоматическим переподключением) ----------
function connect() {
  const s = S;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = s.role ? `?r=${s.role}&t=${s.token || ""}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/ws/${s.roomId}${q}`);
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (S !== s || s.ws !== ws) return;
    s.recvQ = s.recvQ.then(() => onFrame(ev.data)).catch((e) => console.warn(e));
  };
  ws.onclose = (ev) => {
    s.recvQ = s.recvQ.then(() => onWsClose(s, ws, ev.code));
  };
}

function onWsClose(s, ws, code) {
  if (S !== s || s.ended || s.burning || s.ws !== ws) return;
  if (code === 4001) return end(s.admitted ? "endLost" : "endFull");
  if (code === 4002) return end("endRejected");
  if (code === 4003) return burn("endPeerBurned", false);
  if (code === 4004) return end("endLost");
  if (!s.lostAt) s.lostAt = Date.now();
  if (Date.now() - s.lostAt > GRACE_MS) return end("endLost");
  setStatus("reconnecting");
  const delay = Math.min(500 * 2 ** s.retry++, 5000);
  s.retryTm = setTimeout(() => {
    if (S === s && !s.ended) connect();
  }, delay);
}

async function onFrame(raw) {
  if (!S || S.ended) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (data.sys) return onSys(data);

  if (data.w) {
    let m;
    try {
      m = await unseal(S.wrapKey, data.w);
    } catch {
      return;
    }
    return onWrapped(m);
  }

  if (data.s && S.sessionKey) {
    let m;
    try {
      m = await unseal(S.sessionKey, data.s);
    } catch {
      return;
    }
    // защита от повторов и «отражения» своих же сообщений
    if (m.from === S.role || typeof m.n !== "number" || m.n <= S.recvN) return;
    S.recvN = m.n;
    return onSession(m);
  }
}

function onSys(d) {
  switch (d.sys) {
    case "hello": {
      const reconnect = !!S.role;
      S.role = d.role;
      if (typeof d.token === "string") S.token = d.token;
      S.lostAt = 0;
      S.retry = 0;
      if (S.admitted) {
        // вернулись после обрыва
        setPeerPresent(d.peers > 0);
        if (d.peers > 0) setStatus("secured");
        return;
      }
      if (d.role === "host") {
        showPanel("sharePanel");
        $("shareHint").textContent = S.creator || reconnect ? t("shareHint") : t("emptyRoom");
        $("shareBtn").hidden = !navigator.share;
        setStatus("waitingPeer");
        S.peerPub = null;
        S.sessionKey = null;
      } else {
        showPanel("waitPanel");
        renderEmojiRows();
        setStatus(d.peers > 0 ? "knocking" : "hostAway");
        if (d.peers > 0) knock();
      }
      break;
    }
    case "peer-join":
      if (S.admitted) setPeerPresent(true);
      else if (S.role === "guest") {
        // хозяин появился (или вернулся) — стучимся заново
        setStatus("knocking");
        knock();
      }
      break;
    case "peer-left":
      if (S.admitted) setPeerPresent(false);
      else if (S.role === "host") {
        showPanel("sharePanel");
        setStatus("waitingPeer");
        S.peerPub = null;
        S.sessionKey = null;
      } else {
        // хозяин пропал до того, как впустил: ждём его, а не уходим
        S.peerPub = null;
        S.sessionKey = null;
        S.emoji = null;
        renderEmojiRows();
        setStatus("hostAway");
      }
      break;
    case "peer-bye":
      end("endLeft");
      break;
    case "full":
      end(S.admitted ? "endLost" : "endFull");
      break;
    case "ice":
      S.ice = { iceServers: Array.isArray(d.iceServers) && d.iceServers.length ? d.iceServers : STUN_FALLBACK, relay: !!d.relay };
      if (S.hideIp === null) S.hideIp = d.hideIpDefault !== false; // своей настройки нет — берём настройку сервера
      refreshMenu();
      if (S.admitted && !S.peer) setupPeer();
      break;
  }
}

function setPeerPresent(on) {
  const s = S;
  if (on) {
    clearTimeout(s.awayTm);
    s.awayTm = null;
    const wasAway = !s.peerPresent;
    s.peerPresent = true;
    setStatus("secured");
    if (wasAway && s.admitted && s.awaySince) toast(t("peerBack"));
    s.awaySince = 0;
    flush(s);
  } else {
    s.peerPresent = false;
    s.awaySince = Date.now();
    setStatus("peerAway");
    $("typing").hidden = true;
    $("ghost").hidden = true;
    clearTimeout(s.awayTm);
    s.awayTm = setTimeout(() => {
      if (S === s && !s.peerPresent) end("endLeft");
    }, GRACE_MS);
  }
}

// ---------- рукопожатие ----------
async function onWrapped(m) {
  if (m.t === "knock" && S.role === "host" && !S.admitted) {
    const pub = safeBytes(m.pub);
    if (!pub || sameBytes(pub, S.me.pub)) return;
    if (!(S.peerPub && sameBytes(pub, S.peerPub))) {
      if (!(await adoptPeer(pub))) return;
      sounds.knock();
      navigator.vibrate?.([60, 80, 60]);
      notify();
    }
    sendWrapped({ t: "pub", pub: toB64u(S.me.pub) }); // гость тоже увидит эмодзи
    showPanel("knockPanel");
    renderEmojiRows();
    setStatus("knockTitle");
  } else if (m.t === "pub" && S.role === "guest" && !S.admitted) {
    const pub = safeBytes(m.pub);
    if (!pub || sameBytes(pub, S.me.pub)) return;
    if (!(await adoptPeer(pub))) return;
    renderEmojiRows();
  } else if (m.t === "admit" && S.role === "guest" && !S.admitted && S.sessionKey) {
    startChat();
  } else if (m.t === "reject" && S.role === "guest") {
    end("endRejected");
  }
}

function knock() {
  if (!S || S.role !== "guest" || S.admitted) return;
  sendWrapped({ t: "knock", pub: toB64u(S.me.pub) });
}

// «Скрыть мой IP»: звонки и файлы идут через TURN-релей, собеседник не видит твой адрес.
// По умолчанию включено (безопасный вариант; владелец сайта может выключить по умолчанию
// переменной HIDE_IP_DEFAULT=off), работает только если настроен TURN.
// null = пользователь ещё не выбирал сам.
function hideIpPref() {
  try {
    const v = localStorage.getItem("hideip");
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function safeBytes(s) {
  try {
    return typeof s === "string" ? fromB64u(s) : null;
  } catch {
    return null;
  }
}

async function adoptPeer(pub) {
  try {
    const { key, emoji } = await deriveSession(S.me, pub, S.linkKey);
    S.peerPub = pub;
    S.sessionKey = key;
    S.emoji = emoji;
    return true;
  } catch {
    return false;
  }
}

// Четыре эмодзи с названиями — везде, где они показываются.
function emojiRow(el, list) {
  el.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const e = document.createElement("span");
    e.className = "e" + (list ? "" : " dot");
    const glyph = document.createElement("i");
    glyph.textContent = list ? list[i] : "·";
    const name = document.createElement("span");
    name.textContent = list ? emojiName(list[i], lang) : "";
    e.append(glyph, name);
    el.append(e);
  }
}

function renderEmojiRows() {
  if (!S) return;
  for (const id of ["knockEmoji", "waitEmoji", "verifyEmoji", "verifiedEmoji"]) emojiRow($(id), S.emoji);
}

$("admit").onclick = () => {
  if (!S?.sessionKey) return;
  sendWrapped({ t: "admit" });
  startChat();
};

$("reject").onclick = () => {
  if (!S) return;
  sendWrapped({ t: "reject" });
  const s = S;
  s.sendQ = s.sendQ.then(() => s.ws?.readyState === 1 && s.ws.send('{"cmd":"kick"}'));
  S.peerPub = null;
  S.sessionKey = null;
  showPanel("sharePanel");
  setStatus("waitingPeer");
};

// ---------- отправка ----------
function sendWrapped(obj) {
  const s = S;
  s.sendQ = s.sendQ.then(async () => {
    const w = await seal(s.wrapKey, obj);
    if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ w }));
  }).catch(() => {});
}

const canDeliver = (s) => s.ws && s.ws.readyState === 1 && s.peerPresent;

// ephemeral: служебное, если собеседника нет — просто не отправляем
function sendSession(obj, ephemeral = false) {
  const s = S;
  if (!s?.sessionKey) return Promise.resolve();
  s.sendQ = s.sendQ.then(async () => {
    if (ephemeral && !canDeliver(s)) return;
    const frame = JSON.stringify({ s: await seal(s.sessionKey, { ...obj, from: s.role, n: ++s.sendN }) });
    if (canDeliver(s) && !s.outbox.length) s.ws.send(frame);
    else if (s.outbox.length < 3000) s.outbox.push(frame);
  }).catch(() => {});
  return s.sendQ;
}

function flush(s) {
  while (s.outbox.length && canDeliver(s)) s.ws.send(s.outbox.shift());
}

// =====================================================================
// Чат
// =====================================================================
function startChat() {
  S.admitted = true;
  stopCode();
  S.peerPresent = true;
  S.stats.startedAt = Date.now();
  showPanel("chat");
  renderEmojiRows();
  refreshVerify();
  setStatus("secured");
  addSys(t("joined"));
  addEventListener("beforeunload", warnLeave);
  setupFiles();
  requestIce();
  if (!coarse()) $("input").focus();
}

// Адреса для прямого соединения выдаёт сервер только внутри комнаты, где уже двое.
// Если ответ не пришёл за 4 секунды — идём с публичными STUN.
function requestIce() {
  const s = S;
  s.sendQ = s.sendQ.then(() => {
    if (S === s && s.ws?.readyState === 1) s.ws.send('{"cmd":"ice"}');
  }).catch(() => {});
  s.timers.push(setTimeout(() => {
    if (S === s && !s.ended && !s.peer && !s.ice) {
      s.ice = { iceServers: STUN_FALLBACK, relay: false };
      if (s.hideIp === null) s.hideIp = true;
      refreshMenu();
      setupPeer();
    }
  }, 4000));
}

// ---------- ритуал сверки ----------
function refreshVerify() {
  if (!S) return;
  const v = S.verified;
  const both = v.mine && v.theirs;
  $("verify").hidden = both;
  $("verifiedBar").hidden = !both;
  $("verify").classList.toggle("mine", v.mine);
  $("verifyState").textContent = v.mine ? t("verifyMine") : v.theirs ? t("verifyTheirs") : "";
  $("verifiedText").textContent = t("verifyBoth");
  refreshStatus();
}

$("verifyBtn").onclick = () => {
  if (!S?.admitted || S.verified.mine) return;
  S.verified.mine = true;
  sendSession({ t: "verified" });
  onVerifyChange();
};

function onVerifyChange() {
  const was = $("verifiedBar").hidden;
  refreshVerify();
  if (was && S.verified.mine && S.verified.theirs) {
    addSys(t("verifySys"));
    sounds.msg();
    navigator.vibrate?.(30);
  }
}

async function onSession(m) {
  switch (m.t) {
    case "msg": {
      if (typeof m.text !== "string") return;
      $("ghost").hidden = true;
      $("typing").hidden = true;
      const re = m.re && typeof m.re.id === "string" ? { id: m.re.id, text: String(m.re.text || "").slice(0, 160), mine: !!m.re.mine } : null;
      addMsg({ id: String(m.id || newId()), text: m.text.slice(0, 4000), mine: false, ttl: Number(m.ttl) || 0, re });
      S.stats.msgs++;
      incoming(m.id);
      break;
    }
    case "typing":
      $("typing").hidden = false;
      clearTimeout(S.typingTm);
      S.typingTm = setTimeout(() => ($("typing").hidden = true), 3500);
      break;
    case "live": {
      const text = typeof m.text === "string" ? m.text.slice(0, 4000) : "";
      $("typing").hidden = true;
      $("ghost").hidden = !text;
      $("ghost").textContent = text;
      scrollDown();
      break;
    }
    case "seen":
      for (const id of [].concat(m.ids || [])) {
        const rec = S.msgs.get(String(id));
        if (rec?.mine) rec.el.classList.add("seen");
      }
      break;
    case "react":
      setReaction(String(m.id), "theirs", !!m.on);
      break;
    case "del": {
      const rec = S.msgs.get(String(m.id));
      if (rec && !rec.mine) vanishMsg(String(m.id));
      break;
    }
    case "flash-seen": {
      const rec = S.msgs.get(String(m.id));
      if (rec?.mine && rec.badge) rec.badge.replaceChildren(icon("i-check"), document.createTextNode(t("flashSeen")));
      break;
    }
    case "verified":
      S.verified.theirs = true;
      onVerifyChange();
      break;
    case "file": {
      const r = S.files?.onMeta(m);
      if (r?.reject) sendSession({ t: "file-reject", id: r.reject, why: r.why });
      break;
    }
    case "file-reject":
      S.files?.onReject(String(m.id), String(m.why || ""));
      break;
    case "chunk":
      S.files?.onRelayChunk(m);
      break;
    case "rtc":
      if ((m.e || 0) !== S.rtcEpoch) return; // от старого, уже закрытого соединения
      if (S.peer) await S.peer.handle(m);
      else S.rtcPending.push(m);
      break;
    case "rtc-reset": {
      // собеседник пересобирает прямое соединение (например, включил «скрыть IP»)
      S.rtcEpoch++;
      S.rtcPending.length = 0;
      const old = S.peer;
      S.peer = null;
      S.pathKind = null;
      old?.close();
      if (S.call) cleanupCall();
      refreshStatus();
      setupPeer();
      break;
    }
    case "call":
      onCallInvite(!!m.video);
      break;
    case "call-accept":
      onCallAccepted();
      break;
    case "call-decline":
      if (S.call?.state === "outgoing") {
        cleanupCall();
        toast(t("callDeclined"));
      }
      break;
    case "hangup":
      if (S.call) {
        cleanupCall();
        toast(t("callEnded"));
      }
      break;
    case "media":
      if (S.call) {
        S.call.peerMedia = { mic: !!m.mic, video: !!m.video, screen: !!m.screen };
        updateCallUI();
      }
      break;
    case "burn":
      burn("endPeerBurned", false);
      break;
    case "bye":
      end("endLeft");
      break;
  }
}

// новое входящее: звук, счётчик в заголовке, «прочитано»
function incoming(id) {
  const away = document.hidden || !document.hasFocus();
  if (away) {
    S.unseen++;
    document.title = `(${S.unseen}) cant.chat`;
    sounds.msg();
  }
  if (id) {
    if (away) S.unseenIds.push(String(id));
    else sendSession({ t: "seen", ids: [String(id)] }, true);
  }
}

function flushSeen() {
  if (!S?.admitted || !S.unseenIds.length) return;
  sendSession({ t: "seen", ids: S.unseenIds.splice(0) });
}

function notify() {
  if (!S || document.hasFocus()) return;
  S.unseen++;
  document.title = `(${S.unseen}) cant.chat`;
}

function addSys(text) {
  const el = document.createElement("div");
  el.className = "msg sys";
  el.textContent = text;
  $("messages").append(el);
  scrollDown();
}

function bubble({ id, mine, ttl, re }) {
  const el = document.createElement("div");
  el.className = `msg ${mine ? "mine" : "theirs"}`;
  el.dataset.id = id;
  const body = document.createElement("div");
  body.className = "body";
  if (re) {
    const q = document.createElement("span");
    q.className = "quote";
    const who = document.createElement("b");
    // re.mine — с точки зрения отправителя; для получателя наоборот
    const quotedIsMine = mine ? re.mine : !re.mine;
    who.textContent = quotedIsMine ? t("quoteYou") : t("quoteThem");
    q.append(who, document.createTextNode(re.text));
    q.onclick = (e) => {
      e.stopPropagation();
      const target = S?.msgs.get(re.id);
      if (target) {
        target.el.scrollIntoView({ block: "center", behavior: "smooth" });
        target.el.classList.remove("flash");
        void target.el.offsetWidth;
        target.el.classList.add("flash");
      }
    };
    body.append(q);
  }
  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date().toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  const timeEl = document.createElement("span");
  timeEl.textContent = time;
  if (ttl) meta.append(icon("i-hourglass"), document.createTextNode(`${ttl >= 60 ? ttl / 60 + "m" : ttl + "s"} · `));
  meta.append(timeEl);
  if (mine) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.append(icon("i-check"));
    meta.append(tick);
  }
  const react = document.createElement("span");
  react.className = "react";
  react.hidden = true;
  el.append(body, meta, react);
  attachMsgGestures(el, id);
  $("messages").append(el);
  const rec = { el, body, mine, react: { mine: false, theirs: false }, urls: [], text: "" };
  S.msgs.set(id, rec);
  scrollDown();
  if (ttl > 0) {
    S.timers.push(setTimeout(() => vanishMsg(id), ttl * 1000));
  }
  return rec;
}

function vanishMsg(id) {
  const rec = S?.msgs.get(id);
  if (!rec || rec.el.classList.contains("vanish")) return;
  rec.el.classList.add("vanish");
  setTimeout(() => removeMsg(id), 1400);
}

function removeMsg(id) {
  const rec = S?.msgs.get(id);
  if (!rec) return;
  rec.el.remove();
  for (const u of rec.urls) {
    URL.revokeObjectURL(u);
    S.urls.delete(u);
  }
  S.msgs.delete(id);
  if (S.replyTo?.id === id) setReply(null);
}

// Текст с кликабельными ссылками (только http/https, без предпросмотра — ничего не подгружаем).
function renderText(body, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    body.append(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = m[0];
    a.textContent = m[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    body.append(a);
    last = m.index + m[0].length;
  }
  body.append(document.createTextNode(text.slice(last)));
}

function addMsg({ id, text, mine, ttl, re }) {
  const rec = bubble({ id, mine, ttl, re });
  rec.text = text;
  renderText(rec.body, text);
}

function toggleReaction(id) {
  const rec = S?.msgs.get(id);
  if (!rec) return;
  const on = !rec.react.mine;
  setReaction(id, "mine", on);
  sendSession({ t: "react", id, on });
}

function setReaction(id, who, on) {
  const rec = S?.msgs.get(id);
  if (!rec) return;
  rec.react[who] = on;
  const n = Number(rec.react.mine) + Number(rec.react.theirs);
  const r = rec.el.querySelector(".react");
  r.hidden = n === 0;
  r.textContent = n === 2 ? "❤️ 2" : "❤️";
  if (on) {
    r.classList.remove("pop");
    void r.offsetWidth;
    r.classList.add("pop");
  }
}

function scrollDown() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

// ---------- действия с сообщением: долгое нажатие / правый клик ----------
function attachMsgGestures(el, id) {
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    window.getSelection?.()?.removeAllRanges();
    toggleReaction(id);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openSheet(id);
  });
  let tm = null;
  let sx = 0;
  let sy = 0;
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || el.classList.contains("flash") || e.target.closest("a, button, video, .quote")) return;
    sx = e.clientX;
    sy = e.clientY;
    el.classList.add("pressed");
    tm = setTimeout(() => {
      tm = null;
      el.classList.remove("pressed");
      navigator.vibrate?.(20);
      openSheet(id);
    }, 480);
  });
  const cancel = () => {
    clearTimeout(tm);
    tm = null;
    el.classList.remove("pressed");
  };
  el.addEventListener("pointermove", (e) => {
    if (tm && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
}

let sheetFor = null;
function openSheet(id) {
  const rec = S?.msgs.get(id);
  if (!rec) return;
  sheetFor = id;
  const box = $("sheet").querySelector(".sheetbox");
  box.querySelector('[data-act="copy"]').hidden = !rec.text;
  box.querySelector('[data-act="del"]').hidden = !rec.mine;
  $("sheet").hidden = false;
}
$("sheet").onclick = (e) => {
  const btn = e.target.closest("[data-act]");
  $("sheet").hidden = true;
  if (!btn || !sheetFor) return;
  const id = sheetFor;
  sheetFor = null;
  const rec = S?.msgs.get(id);
  if (!rec) return;
  switch (btn.dataset.act) {
    case "react":
      toggleReaction(id);
      break;
    case "reply":
      setReply({ id, text: rec.text || fileLabel(rec), mine: rec.mine });
      $("input").focus();
      break;
    case "copy":
      navigator.clipboard?.writeText(rec.text).then(() => toast(t("copied"))).catch(() => {});
      break;
    case "del":
      sendSession({ t: "del", id });
      vanishMsg(id);
      toast(t("deleted"));
      break;
  }
};

function fileLabel(rec) {
  const m = rec.meta;
  if (!m) return "";
  if (m.kind === "voice") return `🎤 ${t("voice")}`;
  if (/^image\//.test(m.mime)) return `📷 ${t("photo")}`;
  if (/^video\//.test(m.mime)) return `🎬 ${t("video")}`;
  return `📎 ${m.name}`;
}

function setReply(r) {
  if (S) S.replyTo = r;
  $("replyBar").hidden = !r;
  $("replyText").textContent = r ? r.text.slice(0, 160) : "";
}
$("replyCancel").onclick = () => setReply(null);

// ---------- ввод ----------
$("composer").onsubmit = (e) => {
  e.preventDefault();
  if (!S?.admitted) return;
  const text = $("input").value.trim().slice(0, 4000);
  if (!text) return;
  const ttl = TTLS[S.ttlIdx];
  const id = newId();
  const re = S.replyTo ? { id: S.replyTo.id, text: S.replyTo.text.slice(0, 160), mine: S.replyTo.mine } : null;
  sendSession({ t: "msg", id, text, ttl, ...(re ? { re } : {}) });
  if (S.live) sendSession({ t: "live", text: "" }, true);
  addMsg({ id, text, mine: true, ttl, re });
  S.stats.msgs++;
  setReply(null);
  $("input").value = "";
  autoGrow();
  refreshComposer();
  $("input").focus();
};

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse()) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("input").addEventListener("input", () => {
  autoGrow();
  refreshComposer();
  if (!S?.admitted) return;
  if (S.live) {
    if (!S.liveTm) {
      S.liveTm = setTimeout(() => {
        S.liveTm = null;
        if (S) sendSession({ t: "live", text: $("input").value.slice(0, 4000) }, true);
      }, 80);
    }
  } else if (Date.now() - (S.lastTyping || 0) > 2500) {
    S.lastTyping = Date.now();
    sendSession({ t: "typing" }, true);
  }
});

$("input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && S?.admitted) {
    e.preventDefault();
    files.forEach((f) => sendOneFile(f));
  }
});

function autoGrow() {
  const i = $("input");
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight, 160) + "px";
}

// пустое поле → кнопка микрофона, есть текст → кнопка отправки
function refreshComposer() {
  const recording = !!S?.rec;
  const hasText = $("input").value.trim().length > 0;
  const micOk = canRecord();
  $("send").hidden = recording || (!hasText && micOk);
  $("mic").hidden = !recording && (hasText || !micOk);
  $("mic").classList.toggle("recording", recording);
  $("input").hidden = recording;
  $("attach").hidden = recording;
  $("more").hidden = recording;
  $("recInfo").hidden = !recording;
  $("recCancel").hidden = !recording;
}

// ---------- меню «⋯» ----------
$("more").onclick = (e) => {
  e.stopPropagation();
  $("moreMenu").hidden = !$("moreMenu").hidden;
};
document.addEventListener("click", (e) => {
  if (!$("moreMenu").hidden && !$("moreMenu").contains(e.target)) $("moreMenu").hidden = true;
});

function refreshMenu() {
  const ttlIdx = S?.ttlIdx ?? 0;
  const live = !!S?.live;
  $("ttlVal").textContent = TTL_LABEL[ttlIdx];
  $("liveVal").textContent = t(live ? "on" : "off");
  $("fxVal").textContent = t("fx_" + fxMode);
  const flashIdx = S?.flashIdx ?? 0;
  $("flashVal").textContent = flashIdx ? `${FLASH[flashIdx]}s` : t("flashOff");
  $("flashBtn").classList.toggle("on", flashIdx > 0);
  const ipOn = !!(S?.hideIp && S?.ice?.relay);
  $("ipVal").textContent = S?.ice && !S.ice.relay ? t("hideIpNA") : t(S?.hideIp ? "on" : "off");
  $("ipBtn").classList.toggle("on", ipOn);
  $("ttlBtn").classList.toggle("on", ttlIdx > 0);
  $("liveBtn").classList.toggle("on", live);
  $("fxBtn").classList.toggle("on", fxMode !== "off");
  $("more").classList.toggle("on", ttlIdx > 0 || live || fxMode !== "off" || flashIdx > 0);
}

$("ttlBtn").onclick = () => {
  if (!S) return;
  S.ttlIdx = (S.ttlIdx + 1) % TTLS.length;
  refreshMenu();
  toast(S.ttlIdx ? `${t("ttlSet")} ${TTL_LABEL[S.ttlIdx]}` : t("ttlNever"));
};

$("liveBtn").onclick = () => {
  if (!S) return;
  S.live = !S.live;
  refreshMenu();
  toast(t(S.live ? "liveOn" : "liveOff"));
  if (S.admitted) sendSession({ t: "live", text: S.live ? $("input").value : "" }, true);
};

$("flashBtn").onclick = () => {
  if (!S) return;
  S.flashIdx = (S.flashIdx + 1) % FLASH.length;
  refreshMenu();
  toast(S.flashIdx ? tf("flashSet", { n: FLASH[S.flashIdx] }) : t("flashNever"), 3200);
};

$("fxBtn").onclick = () => cycleFx();
$("cFx").onclick = () => cycleFx();

$("ipBtn").onclick = () => {
  if (!S) return;
  if (!S.ice?.relay) return toast(t("hideIpNoTurn"), 4000);
  if (S.call) return toast(t("hideIpBusy"), 3000);
  S.hideIp = !S.hideIp;
  try { localStorage.setItem("hideip", S.hideIp ? "1" : "0"); } catch { /* ignore */ }
  $("moreMenu").hidden = true;
  refreshMenu();
  toast(t(S.hideIp ? "hideIpOn" : "hideIpOff"), 3200);
  rebuildPeer();
};

function cycleFx() {
  fxMode = FX_MODES[(FX_MODES.indexOf(fxMode) + 1) % FX_MODES.length];
  refreshMenu();
  toast(`${t("fxSet")}: ${t("fx_" + fxMode)}`);
  if (S?.call) applyFxToCall();
  updateCallUI();
}

// =====================================================================
// Файлы, фото, голосовые
// =====================================================================
function setupFiles() {
  const s = S;
  s.files = new FileHub({
    dc: () => (s.peer?.open ? s.peer.dc : null),
    send: (obj) => sendSession(obj),
    relayReady: async () => {
      while (S === s && (!canDeliver(s) || s.ws.bufferedAmount > 1 << 20 || s.outbox.length > 20)) {
        await sleep(40);
      }
      if (S !== s) throw new Error("gone");
    },
    on: {
      meta: (meta, mine, blob) => fileBubble(meta, mine, blob),
      progress: (id, frac) => {
        const rec = S?.msgs.get(id);
        if (rec?.bar) rec.bar.style.width = `${Math.round(frac * 100)}%`;
        if (rec && frac >= 1 && rec.mine) rec.el.classList.add("done");
      },
      done: (id, blob) => fileArrived(id, blob),
      fail: (id, why) => {
        const rec = S?.msgs.get(id);
        if (rec) rec.el.classList.add("failed");
        toast(t(why === "memory" ? "peerNoRoom" : "sendFail"), 3500);
      },
    },
  });
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function fileBubble(meta, mine, blob) {
  const ttl = Number(meta.ttl) || 0;
  const re = meta.re && typeof meta.re.id === "string" ? { id: meta.re.id, text: String(meta.re.text || "").slice(0, 160), mine: !!meta.re.mine } : null;
  const rec = bubble({ id: meta.id, mine, ttl, re });
  rec.meta = meta;
  rec.el.classList.add("file");
  const prog = document.createElement("div");
  prog.className = "prog";
  rec.bar = document.createElement("i");
  prog.append(rec.bar);

  const flash = Math.min(60, Number(meta.flash)) || 0;
  if (flash && /^image\//.test(meta.mime) && meta.mime !== "image/svg+xml") {
    rec.flash = flash;
    rec.el.classList.add("flash");
  }
  if (meta.kind === "voice") {
    rec.el.classList.add("voicemsg");
  } else if (rec.flash && !mine) {
    const card = document.createElement("div");
    card.className = "flashcard";
    const txt = document.createElement("span");
    txt.textContent = t("flashReceiving");
    card.append(icon("i-bolt"), txt);
    rec.card = card;
    rec.flashText = txt;
    rec.body.append(card);
    attachFlashHold(rec);
  } else {
    const card = document.createElement("div");
    card.className = "filecard";
    const fi = document.createElement("span");
    fi.className = "ficon";
    fi.append(icon("i-file"));
    const fn = document.createElement("span");
    fn.className = "fname";
    fn.textContent = meta.name;
    const fs = document.createElement("span");
    fs.className = "fsize";
    fs.textContent = fmtSize(meta.size);
    card.append(fi, fn, fs);
    rec.card = card;
    rec.body.append(card);
  }
  rec.body.append(prog);
  S.stats.files++;
  if (mine && blob) renderFile(rec, blob);
  if (!mine) incoming(meta.id);
}

function fileArrived(id, blob) {
  const rec = S?.msgs.get(id);
  if (!rec) return;
  renderFile(rec, blob);
}

function renderFile(rec, blob) {
  const meta = rec.meta;
  const url = URL.createObjectURL(blob);
  rec.urls.push(url);
  S.urls.add(url);
  const mime = blob.type || meta.mime;
  rec.el.classList.add("ready");

  if (meta.kind === "voice") {
    rec.body.prepend(voicePlayer(url, Number(meta.dur) || 0));
    return;
  }
  if (rec.flash && !rec.mine) {
    // Получатель: картинку не показываем, пока не зажмёт. Ссылка на blob не создаётся заранее.
    URL.revokeObjectURL(url);
    rec.urls.pop();
    S.urls.delete(url);
    rec.flashBlob = blob;
    rec.flashText.replaceChildren(document.createTextNode(t("flashHold")));
    const small = document.createElement("small");
    small.textContent = tf("flashOnce", { n: rec.flash });
    rec.flashText.append(small);
    scrollDown();
    return;
  }
  if (/^image\//.test(mime) && mime !== "image/svg+xml") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = meta.name;
    img.className = "thumb";
    img.onload = scrollDown;
    img.onclick = () => openLightbox(url, meta.name);
    rec.card.replaceWith(img);
    rec.card = img;
  } else if (/^video\//.test(mime)) {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.className = "thumb";
    rec.card.replaceWith(v);
    rec.card = v;
  }
  if (rec.flash) {
    // Отправитель: своя копия с пометкой, без кнопки «сохранить»
    rec.badge = document.createElement("span");
    rec.badge.className = "flashbadge";
    rec.badge.append(icon("i-bolt"), document.createTextNode(tf("flashBadge", { n: rec.flash })));
    rec.body.append(rec.badge);
    scrollDown();
    return;
  }
  const save = document.createElement("a");
  save.className = "save";
  save.href = url;
  save.download = meta.name;
  save.append(icon("i-download"), document.createTextNode(`${t("save")} · ${fmtSize(meta.size)}`));
  rec.body.append(save);
  scrollDown();
}

// ---------- фото-вспышка: зажал — видно, отпустил или вышло время — стёрто ----------
let flashOpen = null;
function attachFlashHold(rec) {
  rec.el.addEventListener("pointerdown", (e) => {
    if (!rec.flashBlob || flashOpen || e.button > 0) return;
    e.preventDefault();
    try { rec.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    openFlash(rec);
  });
  const release = () => flashOpen?.rec === rec && closeFlash();
  rec.el.addEventListener("pointerup", release);
  rec.el.addEventListener("pointercancel", release);
  rec.el.addEventListener("contextmenu", (e) => e.preventDefault());
}

function openFlash(rec) {
  const url = URL.createObjectURL(rec.flashBlob);
  flashOpen = { rec, url, tm: setTimeout(closeFlash, rec.flash * 1000) };
  $("flashImg").src = url;
  $("flashView").style.setProperty("--dur", `${rec.flash}s`);
  $("flashView").hidden = false;
}

function closeFlash() {
  const f = flashOpen;
  if (!f) return;
  flashOpen = null;
  clearTimeout(f.tm);
  $("flashView").hidden = true;
  $("flashImg").removeAttribute("src");
  URL.revokeObjectURL(f.url);
  f.rec.flashBlob = null; // картинки больше нет нигде
  f.rec.el.classList.add("viewed");
  f.rec.flashText?.replaceChildren(document.createTextNode(t("flashViewed")));
  sendSession({ t: "flash-seen", id: f.rec.el.dataset.id });
}
addEventListener("pointerup", () => flashOpen && closeFlash());
addEventListener("blur", () => flashOpen && closeFlash());

function voicePlayer(url, dur) {
  const wrap = document.createElement("div");
  wrap.className = "voice";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "vplay";
  btn.append(icon("i-play"));
  const setIcon = (n) => btn.querySelector("use").setAttribute("href", `#${n}`);
  const track = document.createElement("div");
  track.className = "vtrack";
  const fill = document.createElement("i");
  track.append(fill);
  const time = document.createElement("span");
  time.className = "vtime";
  time.textContent = fmtDur(dur);
  const a = new Audio(url);
  a.preload = "auto";
  const total = () => (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : dur || 1);
  btn.onclick = () => (a.paused ? a.play().catch(() => {}) : a.pause());
  a.onplay = () => setIcon("i-pause");
  a.onpause = () => setIcon("i-play");
  a.ontimeupdate = () => {
    fill.style.width = `${Math.min(100, (a.currentTime / total()) * 100)}%`;
    time.textContent = fmtDur(a.currentTime || dur);
  };
  a.onended = () => {
    fill.style.width = "0%";
    time.textContent = fmtDur(dur);
  };
  track.onclick = (e) => {
    const r = track.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * total();
  };
  wrap.append(btn, track, time);
  return wrap;
}

function openLightbox(url, name) {
  $("lbImg").src = url;
  $("lbSave").href = url;
  $("lbSave").download = name;
  $("lightbox").hidden = false;
}
$("lightbox").onclick = (e) => {
  if (!e.target.closest("#lbSave")) $("lightbox").hidden = true;
};

async function sendOneFile(file, extra = {}) {
  if (!S?.files) return;
  const re = S.replyTo ? { id: S.replyTo.id, text: S.replyTo.text.slice(0, 160), mine: S.replyTo.mine } : null;
  if (re) setReply(null);
  const flash = S.flashIdx && !extra.kind && /^image\//.test(file.type) ? { flash: FLASH[S.flashIdx] } : {};
  try {
    await S.files.sendFile(file, { ttl: TTLS[S.ttlIdx], ...(re ? { re } : {}), ...flash, ...extra });
  } catch (e) {
    toast(e.relay ? t("tooBigRelay") : t("tooBig"), 3500);
  }
}

$("attach").onclick = () => $("fileInput").click();
$("fileInput").onchange = () => {
  [...$("fileInput").files].forEach((f) => sendOneFile(f));
  $("fileInput").value = "";
};

// перетаскивание файлов
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if (!S?.admitted || !e.dataTransfer?.types?.includes("Files")) return;
  dragDepth++;
  $("dropZone").hidden = false;
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropZone").hidden = true;
  }
});
addEventListener("dragover", (e) => {
  if (S?.admitted) e.preventDefault();
});
addEventListener("drop", (e) => {
  if (!S?.admitted) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropZone").hidden = true;
  [...(e.dataTransfer?.files || [])].forEach((f) => sendOneFile(f));
});

// ---------- голосовые: удерживай или нажми ----------
let pressAt = 0;
$("mic").addEventListener("pointerdown", async (e) => {
  if (!S?.admitted) return;
  e.preventDefault();
  if (S.rec) {
    if (S.rec.handle) finishRec(true);
    return;
  }
  pressAt = Date.now();
  S.rec = { handle: null };
  refreshComposer();
  $("recFx").textContent = fxMode !== "off" ? `${t("fxSet")}: ${t("fx_" + fxMode)}` : t("tapToStop");
  const rec = S.rec;
  try {
    rec.handle = await startRecording(fxMode);
  } catch {
    if (S?.rec === rec) S.rec = null;
    refreshComposer();
    toast(t("noMedia"), 3500);
    return;
  }
  if (S?.rec !== rec) {
    rec.handle.cancel();
    return;
  }
  rec.tick = setInterval(() => {
    $("recTime").textContent = fmtDur(rec.handle.elapsed());
    if (rec.handle.elapsed() > 300) finishRec(true);
  }, 200);
});
$("mic").addEventListener("pointerup", () => {
  if (S?.rec?.handle && Date.now() - pressAt > 450 && S.rec.handle.elapsed() > 0.4) finishRec(true);
});
$("mic").addEventListener("contextmenu", (e) => e.preventDefault());
$("recCancel").onclick = () => finishRec(false);

async function finishRec(send) {
  const rec = S?.rec;
  if (!rec) return;
  S.rec = null;
  clearInterval(rec.tick);
  $("recTime").textContent = "0:00";
  refreshComposer();
  if (!rec.handle) return;
  if (!send) return rec.handle.cancel();
  const { blob, dur } = await rec.handle.stop();
  if (dur < 0.6 || blob.size < 200) return toast(t("recShort"));
  const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  sendOneFile(new File([blob], `voice.${ext}`, { type: blob.type }), { kind: "voice", dur: Math.round(dur * 10) / 10 });
}

// =====================================================================
// Прямое соединение и звонки
// =====================================================================
async function setupPeer() {
  const s = S;
  if (!s || s.ended || s.peer || !s.ice) return;
  if (typeof window.RTCPeerConnection !== "function") {
    // очень старый браузер: переписка и файлы работают через сервер, звонков нет
    $("audioCall").hidden = $("videoCall").hidden = true;
    return;
  }
  // Режим «скрыть мой IP» возможен только при наличии TURN.
  s.relayOnly = s.hideIp && s.ice.relay;
  s.remoteStream = new MediaStream();
  try {
    s.peer = new Peer({
      polite: s.role === "guest",
      iceServers: s.ice.iceServers,
      relayOnly: s.relayOnly,
      signal: (msg) => sendSession({ t: "rtc", e: s.rtcEpoch, ...msg }),
      onTrack: (e) => {
        if (S !== s) return;
        s.remoteStream.addTrack(e.track);
        e.track.onended = () => s.remoteStream.removeTrack(e.track);
        const v = $("remoteVideo");
        // Safari надёжнее заново получает поток, чем замечает новые дорожки в старом
        v.srcObject = s.remoteStream;
        v.play().catch(() => {});
      },
      onState: (st) => {
        if (S !== s) return;
        if (st === "connected") s.peer?.pathKind().then((k) => S === s && ((s.pathKind = k), refreshStatus()));
        refreshStatus();
      },
      onChannel: (dc) => {
        dc.onopen = () => S === s && refreshStatus();
        dc.onclose = () => S === s && refreshStatus();
        dc.onmessage = (e) => s.files?.onChannelMessage(e);
      },
    });
  } catch (e) {
    console.warn("rtc unavailable", e);
    s.peer = null;
    return;
  }
  refreshMenu();
  for (const m of s.rtcPending.splice(0)) await s.peer.handle(m);
}

// Переключили «скрыть IP» посреди разговора: пересобираем прямое соединение
// (только когда нет звонка, чтобы не оборвать его).
async function rebuildPeer() {
  const s = S;
  if (!s?.peer || s.call) return;
  const old = s.peer;
  s.peer = null;
  s.pathKind = null;
  old.close();
  s.rtcEpoch++;
  s.rtcPending.length = 0;
  sendSession({ t: "rtc-reset" });
  refreshStatus();
  await sleep(300);
  if (S === s) setupPeer();
}

$("audioCall").onclick = () => startCall(false);
$("videoCall").onclick = () => startCall(true);

async function getCallMedia(video) {
  const c = { micRaw: null, pipe: null, cam: null, screen: null, facing: "user" };
  try {
    c.micRaw = await getMic();
  } catch { /* без микрофона */ }
  if (video) {
    try {
      c.cam = await getCam("user");
    } catch { /* без камеры */ }
  }
  if (c.micRaw && fxMode !== "off") c.pipe = await voicePipeline(c.micRaw, fxMode);
  if (!c.micRaw && !c.cam) toast(t("noMedia"), 3500);
  return c;
}

async function startCall(video) {
  if (!S?.admitted) return;
  if (S.call) return toast(t("callBusy"));
  if (!S.peer) return toast(t("p2pWait"));
  const s = S;
  s.call = { state: "outgoing", video, peerMedia: { mic: true, video: false, screen: false }, senders: {} };
  updateCallUI();
  Object.assign(s.call, await getCallMedia(video));
  if (S !== s || !s.call) return;
  if (!s.call.micRaw && !s.call.cam) {
    s.call = null;
    return updateCallUI();
  }
  startRing("out");
  sendSession({ t: "call", video });
  s.call.timeout = setTimeout(() => {
    if (S === s && s.call?.state === "outgoing") {
      sendSession({ t: "hangup" });
      cleanupCall();
      toast(t("noAnswer"));
    }
  }, CALL_TIMEOUT);
  updateCallUI();
}

function onCallInvite(video) {
  if (S.call) {
    // оба позвонили одновременно: звонок хозяина комнаты главнее
    if (S.call.state === "outgoing" && S.role === "guest") {
      clearTimeout(S.call.timeout);
      stopRing();
      S.call.state = "active";
      S.call.startedAt = Date.now();
      attachTracks();
      sendSession({ t: "call-accept" });
      sendMediaState();
      updateCallUI();
    }
    return;
  }
  S.call = { state: "incoming", video, peerMedia: { mic: true, video, screen: false }, senders: {} };
  $("ringIconUse").setAttribute("href", video ? "#i-video" : "#i-phone");
  $("ringText").textContent = t(video ? "incomingVideo" : "incomingAudio");
  $("ring").hidden = false;
  startRing("in");
  notify();
}

$("ringAccept").onclick = async () => {
  const s = S;
  if (!s?.call || s.call.state !== "incoming") return;
  stopRing();
  $("ring").hidden = true;
  s.call.state = "connecting";
  updateCallUI();
  Object.assign(s.call, await getCallMedia(s.call.video));
  if (S !== s || !s.call) return;
  s.call.state = "active";
  s.call.startedAt = Date.now();
  attachTracks();
  sendSession({ t: "call-accept" });
  sendMediaState();
  updateCallUI();
};

$("ringDecline").onclick = () => {
  if (!S?.call) return;
  sendSession({ t: "call-decline" });
  cleanupCall();
};

function onCallAccepted() {
  const c = S.call;
  if (!c || c.state !== "outgoing") return;
  clearTimeout(c.timeout);
  stopRing();
  c.state = "active";
  c.startedAt = Date.now();
  attachTracks();
  sendMediaState();
  updateCallUI();
}

function micOut(c) {
  return c.pipe ? c.pipe.track : c.micRaw;
}

function attachTracks() {
  const c = S.call;
  keepAwake(true);
  const pc = S.peer.pc;
  c.localStream = new MediaStream();
  const mic = micOut(c);
  if (mic) c.senders.audio = pc.addTrack(mic, c.localStream);
  const vid = c.screen || c.cam;
  if (vid) c.senders.video = pc.addTrack(vid, c.localStream);
  let n = 0;
  c.tick = setInterval(() => {
    updateCallUI();
    if (++n % 5 === 0 && S?.peer) S.peer.pathKind().then((k) => S && ((S.pathKind = k), refreshStatus()));
  }, 1000);
}

function sendMediaState() {
  const c = S?.call;
  if (!c) return;
  sendSession({ t: "media", mic: !!(c.micRaw && c.micRaw.enabled), video: !!(c.cam || c.screen), screen: !!c.screen });
}

async function setVideoTrack(track) {
  const c = S.call;
  if (c.senders.video) await c.senders.video.replaceTrack(track);
  else if (track) c.senders.video = S.peer.pc.addTrack(track, c.localStream);
}

async function applyFxToCall() {
  const c = S.call;
  if (!c?.micRaw) return;
  if (c.pipe) {
    if (fxMode === "off") {
      const old = c.pipe;
      c.pipe = null;
      await c.senders.audio?.replaceTrack(c.micRaw);
      old.stop();
    } else c.pipe.setMode(fxMode);
  } else if (fxMode !== "off") {
    c.pipe = await voicePipeline(c.micRaw, fxMode);
    if (c.pipe) await c.senders.audio?.replaceTrack(c.pipe.track);
  }
}

$("cMic").onclick = async () => {
  const c = S?.call;
  if (!c) return;
  if (!c.micRaw) {
    try {
      c.micRaw = await getMic();
      if (fxMode !== "off") c.pipe = await voicePipeline(c.micRaw, fxMode);
      if (c.state === "active") {
        if (c.senders.audio) await c.senders.audio.replaceTrack(micOut(c));
        else c.senders.audio = S.peer.pc.addTrack(micOut(c), c.localStream);
      }
    } catch {
      return toast(t("noMedia"), 3500);
    }
  } else c.micRaw.enabled = !c.micRaw.enabled;
  sendMediaState();
  updateCallUI();
};

$("cCam").onclick = async () => {
  const c = S?.call;
  if (!c) return;
  if (c.cam) {
    c.cam.stop();
    c.cam = null;
    if (!c.screen && c.state === "active") await setVideoTrack(null);
  } else {
    try {
      c.cam = await getCam(c.facing);
    } catch {
      return toast(t("noMedia"), 3500);
    }
    if (!c.screen && c.state === "active") await setVideoTrack(c.cam);
  }
  sendMediaState();
  updateCallUI();
};

$("cFlip").onclick = async () => {
  const c = S?.call;
  if (!c?.cam) return;
  c.facing = c.facing === "user" ? "environment" : "user";
  const old = c.cam;
  old.stop();
  try {
    c.cam = await getCam(c.facing);
  } catch {
    c.cam = null;
  }
  if (!c.screen && c.state === "active") await setVideoTrack(c.cam);
  sendMediaState();
  updateCallUI();
};

$("cScreen").onclick = async () => {
  const c = S?.call;
  if (!c) return;
  if (c.screen) return stopScreen();
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    c.screen = st.getVideoTracks()[0];
    c.screen.onended = () => stopScreen();
    if (c.state === "active") await setVideoTrack(c.screen);
    sendMediaState();
    updateCallUI();
  } catch { /* отменили */ }
};

async function stopScreen() {
  const c = S?.call;
  if (!c?.screen) return;
  c.screen.stop();
  c.screen = null;
  if (c.state === "active") await setVideoTrack(c.cam || null);
  sendMediaState();
  updateCallUI();
}

$("cEnd").onclick = () => {
  if (!S?.call) return;
  sendSession({ t: "hangup" });
  cleanupCall();
};

$("cExpand").onclick = () => $("call").classList.toggle("full");

function cleanupCall() {
  const s = S;
  const c = s?.call;
  if (!c) return;
  stopRing();
  clearTimeout(c.timeout);
  clearInterval(c.tick);
  c.pipe?.stop();
  c.micRaw?.stop();
  c.cam?.stop();
  c.screen?.stop();
  const pc = s.peer?.pc;
  for (const sender of Object.values(c.senders)) {
    try {
      pc?.removeTrack(sender);
    } catch { /* ignore */ }
  }
  s.call = null;
  keepAwake(false);
  if (s.remoteStream) for (const tr of s.remoteStream.getTracks()) s.remoteStream.removeTrack(tr);
  $("ring").hidden = true;
  $("localVideo").srcObject = null;
  updateCallUI();
}

function updateCallUI() {
  const c = S?.call;
  const box = $("call");
  if (!c || c.state === "incoming") {
    box.hidden = true;
    box.classList.remove("video", "full");
    return;
  }
  box.hidden = false;
  const localVid = c.screen || c.cam;
  const remoteVid = c.state === "active" && c.peerMedia.video;
  box.classList.toggle("video", !!(localVid || remoteVid));
  $("remoteVideo").classList.toggle("on", !!remoteVid);
  $("callAvatar").hidden = !!remoteVid;
  $("callOrb").classList.toggle("speaking", c.state === "active");

  const lv = $("localVideo");
  if (localVid) {
    if (lv.srcObject?.getVideoTracks()[0] !== localVid) lv.srcObject = new MediaStream([localVid]);
    lv.hidden = false;
    lv.classList.toggle("mirror", !c.screen && c.facing === "user");
  } else {
    lv.hidden = true;
    lv.srcObject = null;
  }

  let state = "";
  if (c.state === "outgoing") state = t("calling");
  else if (c.state === "connecting") state = t("connectingCall");
  else if (c.startedAt) state = fmtDur((Date.now() - c.startedAt) / 1000);
  if (fxMode !== "off") state += ` · ${t("fx_" + fxMode)}`;
  if (c.state === "active" && S.pathKind) state += ` · ${t(S.pathKind === "relay" ? "viaRelay" : "direct")}`;
  $("callState").textContent = state;
  const flags = [];
  if (c.state === "active" && !c.peerMedia.mic) flags.push(t("peerMuted"));
  if (c.state === "active" && c.peerMedia.screen) flags.push(t("peerScreen"));
  $("peerFlags").textContent = flags.join(" · ");

  const micOn = !!(c.micRaw && c.micRaw.enabled);
  $("cMic").setAttribute("aria-pressed", String(!micOn));
  $("cMicUse").setAttribute("href", micOn ? "#i-mic" : "#i-mic-off");
  $("cCam").setAttribute("aria-pressed", String(!!c.cam));
  $("cCamUse").setAttribute("href", c.cam ? "#i-cam" : "#i-cam-off");
  $("cScreen").hidden = !canShareScreen();
  $("cScreen").setAttribute("aria-pressed", String(!!c.screen));
  $("cFx").classList.toggle("on", fxMode !== "off");
  if (c.cam && $("cFlip").dataset.checked !== "1") {
    $("cFlip").dataset.checked = "1";
    cameraCount().then((n) => ($("cFlip").hidden = n < 2));
  }
  if (!c.cam) $("cFlip").hidden = true;
}

// =====================================================================
// Ссылка, сжечь, выход
// =====================================================================
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(S.link);
  } catch {
    $("shareLink").select();
    document.execCommand("copy");
  }
  $("copyLabel").textContent = t("copied");
  setTimeout(() => ($("copyLabel").textContent = t("copy")), 1500);
};
$("shareLink").onclick = () => $("shareLink").select();
$("shareBtn").onclick = () => navigator.share?.({ title: "cant.chat", url: S.link }).catch(() => {});

// ---------- код комнаты словами (запасной способ позвать, когда ссылку передать нельзя) ----------
// Подробно: public/code.js. Хозяин ждёт в «прихожей» до 10 минут; гость, введя слова, приходит туда,
// получает настоящий ключ комнаты (зашифрованный ключом из слов) и стучится в комнату как обычно.
const wsUrl = (roomId, q = "") => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${roomId}${q}`;

function renderCode() {
  const c = S?.code;
  $("codePanel").hidden = !c;
  $("codeSetForm").hidden = !!c;
  $("codeRule").hidden = !!c;
  $("codePanel").classList.toggle("used", !!c?.used);
  $("codeHint").textContent = c?.used ? t("codeUsed") : t("codeHint");
  $("codeShow").textContent = c ? c.text : "";
  if (!c) {
    $("codeSetErr").hidden = true;
    $("codeSet").disabled = false;
  }
}

async function startCode(text) {
  const s = S;
  if (!s || s.role !== "host" || s.admitted || s.code || s.codeBusy) return;
  const problem = codeProblem(text);
  if (problem) {
    $("codeSetErr").textContent = tf("codeErr" + problem[0].toUpperCase() + problem.slice(1), { n: CODE_MIN });
    $("codeSetErr").hidden = false;
    return;
  }
  s.codeBusy = true;
  $("codeSet").disabled = true;
  $("codeSetErr").textContent = t("codeChecking");
  $("codeSetErr").classList.add("busy");
  $("codeSetErr").hidden = false;
  const key = await codeKey(text);
  const c = { text: normalizeCode(text), key, roomId: await roomIdFor(key), wrapKey: await wrapKeyFor(key), ws: null, used: false, endAt: Date.now() + CODE_TTL_MS };
  s.codeBusy = false;
  $("codeSetErr").classList.remove("busy");
  if (S !== s || s.ended || s.admitted) return;
  s.code = c;
  $("codeEdit").value = "";
  renderCode();
  const ws = new WebSocket(wsUrl(c.roomId));
  c.ws = ws;
  ws.onmessage = async (ev) => {
    if (S !== s || s.code !== c) return;
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.sys === "hello" && d.role !== "host") {
      // с таким кодом уже кто-то ждёт (другой хозяин выбрал тот же код) — нужен другой
      stopCode();
      $("codeSetErr").textContent = t("codeBusy");
      $("codeSetErr").hidden = false;
    } else if (d.sys === "peer-join" && !c.used) {
      c.used = true;
      renderCode();
      const w = await seal(c.wrapKey, { t: "code-key", name: s.name, key: toB64u(s.linkKey) });
      try { ws.send(JSON.stringify({ w })); } catch { /* ушёл */ }
      // код одноразовый: закрываем прихожую, он больше ничего не открывает
      setTimeout(() => { if (S === s && s.code === c) stopCode(); }, 1500);
    }
  };
  ws.onclose = () => { if (S === s && s.code === c && !c.used) stopCode(); };
  const tick = () => {
    if (S !== s || s.code !== c) return clearInterval(c.tick);
    const left = c.endAt - Date.now();
    if (left <= 0) stopCode();
    else $("codeTimer").textContent = fmtDur(left / 1000);
  };
  tick();
  c.tick = setInterval(tick, 500);
}

function stopCode() {
  const c = S?.code;
  if (!c) return;
  clearInterval(c.tick);
  try { c.ws?.close(); } catch { /* ignore */ }
  c.key.fill(0);
  S.code = null;
  renderCode();
}

// Живой индикатор силы кода под полем
function showStrength(el, text, min) {
  const c = normalizeCode(text);
  if (!c) return (el.hidden = true);
  const { level } = codeStrength(c);
  const short = c.replace(/\s/g, "").length < min;
  el.hidden = false;
  el.className = `strength l${short ? 0 : level}`;
  el.textContent = short ? tf("codeErrShort", { n: min }) : t("strength" + level);
}
$("codeEdit").addEventListener("input", () => showStrength($("codeStrength"), $("codeEdit").value, CODE_MIN));
$("noteCode").addEventListener("input", () => showStrength($("noteStrength"), $("noteCode").value, NOTE_CODE_MIN));

$("codeSetForm").onsubmit = (e) => {
  e.preventDefault();
  startCode($("codeEdit").value);
};
$("codeOff").onclick = () => stopCode();
$("codeCopy").onclick = async () => {
  if (!S?.code) return;
  try { await navigator.clipboard.writeText(S.code.text); } catch { /* ignore */ }
  $("codeCopyLabel").textContent = t("copied");
  setTimeout(() => ($("codeCopyLabel").textContent = t("codeCopy")), 1500);
};

// Гость: ввёл код на главной
function codeNote(text, busy = false) {
  $("codeErr").textContent = text;
  $("codeErr").hidden = !text;
  $("codeErr").classList.toggle("busy", busy);
}
$("codeForm").onsubmit = async (e) => {
  e.preventDefault();
  if (S || $("codeGo").disabled) return;
  const text = $("codeInput").value;
  if (codeProblem(text)) return codeNote(t("codeBad"));
  $("codeGo").disabled = true;
  codeNote(t("codeChecking"), true);
  const key = await codeKey(text);
  // Сначала записка: если под этим кодом она лежит на сервере — открываем (и сервер её удаляет).
  const noteResult = await openNote(key);
  if (noteResult !== "none") {
    $("codeGo").disabled = false;
    if (noteResult === "ok") {
      key.fill(0);
      $("codeInput").value = "";
      codeNote("");
    } else codeNote(t(noteResult === "net" ? "noteErrNet" : "codeBad"));
    return;
  }
  const roomId = await roomIdFor(key);
  const wrapKey = await wrapKeyFor(key);
  const ws = new WebSocket(wsUrl(roomId));
  let done = false;
  const fail = (k) => {
    if (done) return;
    done = true;
    clearTimeout(tm);
    try { ws.close(); } catch { /* ignore */ }
    $("codeGo").disabled = false;
    codeNote(t(k));
  };
  const tm = setTimeout(() => fail("codeNoHost"), 12000);
  ws.onmessage = async (ev) => {
    if (done) return;
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.sys === "hello") {
      if (d.role === "host" || !(d.peers > 0)) fail("codeNoHost"); // хозяина с таким кодом нет
      return;
    }
    if (d.sys === "full") return fail("codeNoHost");
    if (!d.w) return;
    let m;
    try { m = await unseal(wrapKey, d.w); } catch { return; }
    if (m.t !== "code-key") return;
    const lk = safeBytes(m.key);
    if (!lk || lk.length !== 32 || typeof m.name !== "string" || !/^[a-z]+-[a-z]+-\d{2}$/.test(m.name)) return fail("codeBad");
    done = true;
    clearTimeout(tm);
    try { ws.close(); } catch { /* ignore */ }
    key.fill(0);
    $("codeGo").disabled = false;
    $("codeInput").value = "";
    codeNote("");
    $("codeForm").hidden = true;
    enterRoom({ name: m.name, linkKey: lk, creator: false });
  };
  ws.onclose = () => fail("codeNoHost");
  ws.onerror = () => fail("codeNoHost");
};

// ---------- сжечь: зажать на секунду ----------
// Одна и та же механика для комнаты и для записки.
function holdToBurn(btn, label, { canBurn, onBurn }) {
  let tm = null;
  let start = 0;
  let armTm = null;
  const reset = () => {
    clearTimeout(armTm);
    clearTimeout(tm);
    tm = null;
    btn.classList.remove("armed", "holding");
    label.textContent = t("burn");
  };
  btn.addEventListener("pointerdown", (e) => {
    if (!canBurn() || e.button > 0) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    start = Date.now();
    btn.classList.add("holding");
    label.textContent = t("burnHold");
    navigator.vibrate?.(15);
    clearTimeout(tm);
    tm = setTimeout(() => {
      tm = null;
      if (canBurn()) onBurn();
    }, BURN_HOLD_MS);
  });
  const release = () => {
    if (!tm) return;
    const held = Date.now() - start;
    reset();
    if (held < BURN_HOLD_MS && canBurn()) toast(t("burnHint"), 1600);
  };
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  // С клавиатуры: два нажатия Enter/Space подряд.
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (!canBurn()) return;
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      label.textContent = t("burnHint");
      armTm = setTimeout(reset, 3000);
      return;
    }
    onBurn();
  });
  return reset;
}

const disarmBurn = holdToBurn($("burn"), $("burnLabel"), {
  canBurn: () => !!S && !S.burning,
  onBurn: () => burn("endBurned", true),
});

function burn(reason, tellPeer) {
  if (!S || S.ended || S.burning) return;
  S.burning = true;
  const s = S;
  if (tellPeer && s.admitted) sendSession({ t: "burn" });
  s.sendQ = s.sendQ.then(() => {
    if (s.ws.readyState === 1) s.ws.send('{"cmd":"burn"}');
  });
  fireUp($("room"));
  setTimeout(() => end(reason), 1700);
}

// Огонь и искры поверх экрана (комната или записка).
function fireUp(view) {
  sounds.burn();
  navigator.vibrate?.([40, 60, 120]);
  const embers = view.querySelector(".embers");
  embers.replaceChildren();
  for (let i = 0; i < 18; i++) {
    const e = document.createElement("i");
    e.style.left = `${Math.random() * 100}%`;
    e.style.animationDelay = `${Math.random() * 0.9}s`;
    e.style.setProperty("--dx", `${(Math.random() - 0.5) * 120}px`);
    embers.append(e);
  }
  view.classList.add("burning");
}

function end(reason) {
  if (!S || S.ended) return;
  const s = S;
  s.ended = true;
  try { cleanupCall(); } catch { /* ignore */ }
  if (s.rec?.handle) s.rec.handle.cancel();
  clearInterval(s.rec?.tick);
  for (const tm of s.timers) {
    clearTimeout(tm);
    clearInterval(tm);
  }
  clearTimeout(s.typingTm);
  clearTimeout(s.liveTm);
  clearTimeout(s.awayTm);
  clearTimeout(s.retryTm);
  disarmBurn();
  closeFlash();
  stopCode();
  s.files?.stop();
  s.peer?.close();
  try {
    s.ws.close();
  } catch { /* ignore */ }
  for (const u of s.urls) URL.revokeObjectURL(u);
  // статистика для финального экрана — только числа, без содержимого
  const secs = s.stats.startedAt ? Math.round((Date.now() - s.stats.startedAt) / 1000) : 0;
  const stats = s.admitted
    ? tf("stats", { m: s.stats.msgs, f: s.stats.files, t: secs >= 60 ? tf("statsMin", { n: Math.round(secs / 60) }) : tf("statsSec", { n: secs }) })
    : "";
  // стираем всё из памяти
  s.linkKey.fill(0);
  s.outbox.length = 0;
  s.msgs.clear();
  S = null;
  removeEventListener("beforeunload", warnLeave);
  $("messages").replaceChildren();
  $("qrWrap").classList.remove("open"); $("qrBtn").setAttribute("aria-expanded", "false");
  $("qr").replaceChildren();
  $("input").value = "";
  $("ghost").textContent = "";
  $("shareLink").value = "";
  $("remoteVideo").srcObject = null;
  $("lightbox").hidden = true;
  $("flashView").hidden = true;
  $("sheet").hidden = true;
  $("lbImg").removeAttribute("src");
  $("room").classList.remove("burning");
  $("burnFx").querySelector(".embers").replaceChildren();
  document.body.classList.remove("veiled");
  $("veil").hidden = true;
  document.title = "cant.chat";
  $("endTitle").textContent = t(reason);
  $("endStats").textContent = stats;
  $("endStats").hidden = !stats;
  refreshComposer();
  if (reason !== "endBurned" && reason !== "endPeerBurned") sounds.end();
  show("end");
}

function warnLeave(e) {
  e.preventDefault();
  e.returnValue = t("leaveWarn");
  return t("leaveWarn");
}

// Закрыл вкладку — сразу говорим собеседнику, чтобы он не ждал.
addEventListener("pagehide", () => {
  if (S?.ws?.readyState === 1) {
    try { S.ws.send('{"cmd":"leave"}'); } catch { /* ignore */ }
  }
});

// ---------- паник-кнопка: Esc Esc ----------
let lastEsc = 0;
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("sheet").hidden) {
    $("sheet").hidden = true;
    return;
  }
  if (!$("cipherPop").hidden) {
    closeCipher();
    return;
  }
  if (!$("lightbox").hidden) {
    $("lightbox").hidden = true;
    return;
  }
  if (flashOpen) {
    closeFlash();
    return;
  }
  if (!$("moreMenu").hidden) {
    $("moreMenu").hidden = true;
    return;
  }
  if (!S && $("note").hidden) return;
  const now = Date.now();
  if (now - lastEsc < 600) {
    try {
      S?.ws.send('{"cmd":"leave"}');
      S?.ws.close();
    } catch { /* ignore */ }
    S = null;
    document.body.replaceChildren();
    location.replace("about:blank");
  }
  lastEsc = now;
});

// ---------- приватный блюр ----------
function veil(on) {
  if (!S?.admitted || S.call || S.rec) on = false; // во время звонка/записи не мешаем
  document.body.classList.toggle("veiled", on);
  $("veil").hidden = !on;
  if (!on && S && document.hasFocus()) {
    S.unseen = 0;
    document.title = "cant.chat";
    flushSeen();
  }
}
addEventListener("blur", () => veil(true));
addEventListener("focus", () => veil(false));
document.addEventListener("visibilitychange", () => veil(document.hidden));
$("veil").onclick = () => veil(false);

// =====================================================================
// Записка: сгорает при прочтении. Единственное, что сервер хранит, — зашифрованный блок.
// Ключ — из кода (PBKDF2), сервер его не знает. Подробно: src/worker.js (класс Note), public/code.js.
// =====================================================================
const NOTE_IMG_MAX = 1_000_000;
let N = null; // черновик записки
let noteView = null; // открытая записка (url картинки)

function noteCount() {
  $("noteCount").textContent = `${$("noteText").value.length} / 10000`;
}

$("noteBtn").onclick = () => {
  N = { img: null, ttl: 86400 };
  $("noteText").value = "";
  $("noteCode").value = "";
  $("noteErr").hidden = true;
  $("notePreviewWrap").hidden = true;
  $("notePreview").removeAttribute("src");
  for (const b of $("noteTtlSeg").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.ttl === "86400"));
  noteCount();
  $("noteCompose").hidden = false;
  $("noteSealed").hidden = true;
  $("noteRead").hidden = true;
  show("note");
  if (!coarse()) $("noteText").focus();
};
$("noteBack").onclick = () => {
  N = null;
  show("home");
};
$("noteText").addEventListener("input", noteCount);
for (const b of $("noteTtlSeg").querySelectorAll("button")) {
  b.onclick = () => {
    if (N) N.ttl = Number(b.dataset.ttl);
    for (const o of $("noteTtlSeg").querySelectorAll("button")) o.setAttribute("aria-checked", String(o === b));
  };
}
$("notePhoto").onclick = () => $("noteFile").click();
$("noteFile").onchange = async () => {
  const f = $("noteFile").files[0];
  $("noteFile").value = "";
  if (!f || !N) return;
  const blob = await shrinkImage(f);
  if (!blob) return noteErr(t("noteErrBig"));
  N.img = blob;
  const url = URL.createObjectURL(blob);
  $("notePreview").src = url;
  $("notePreviewWrap").hidden = false;
  $("notePreview").onload = () => URL.revokeObjectURL(url);
};
$("notePreviewX").onclick = () => {
  if (N) N.img = null;
  $("notePreviewWrap").hidden = true;
  $("notePreview").removeAttribute("src");
};

function noteErr(text, busy = false) {
  $("noteErr").textContent = text;
  $("noteErr").hidden = !text;
  $("noteErr").classList.toggle("busy", busy);
}

// Фото ужимаем до 1 МБ прямо в браузере (телефонные снимки по 4–8 МБ иначе не влезут).
async function shrinkImage(file) {
  if (file.size <= NOTE_IMG_MAX && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) return file;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null;
  }
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  let q = 0.85;
  for (let i = 0; i < 12; i++) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= NOTE_IMG_MAX) return blob;
    if (q > 0.6) q -= 0.1;
    else scale *= 0.75;
  }
  return null;
}

const ttlLabel = (ttl) => t(ttl === 3600 ? "ttl1h" : ttl === 604800 ? "ttl7d" : "ttl24h");

$("noteForm").onsubmit = async (e) => {
  e.preventDefault();
  if (!N || $("noteSeal").disabled) return;
  const text = $("noteText").value.trim().slice(0, 10000);
  if (!text && !N.img) return noteErr(t("noteEmpty"));
  const code = $("noteCode").value;
  const problem = codeProblem(code, NOTE_CODE_MIN);
  if (problem) return noteErr(tf("codeErr" + problem[0].toUpperCase() + problem.slice(1), { n: NOTE_CODE_MIN }));
  $("noteSeal").disabled = true;
  noteErr(t("noteSealing"), true);
  try {
    const key = await codeKey(code);
    const nkey = await noteKeyFor(key);
    const id = await noteIdFor(key);
    key.fill(0);
    const payload = { text };
    if (N.img) payload.img = { mime: N.img.type, b64: toB64u(new Uint8Array(await N.img.arrayBuffer())) };
    const ct = await seal(nkey, payload);
    const r = await fetch(`/note/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ct, ttl: N.ttl }) });
    if (r.status === 409) return noteErr(t("noteErrTaken"));
    if (!r.ok) return noteErr(t("noteErrNet"));
    // запечатано: черновик стираем, показываем код
    const shown = normalizeCode(code);
    const ttl = N.ttl;
    N = null;
    $("noteText").value = "";
    $("noteCode").value = "";
    $("notePreview").removeAttribute("src");
    $("noteCodeShow").textContent = shown;
    $("noteSealedInfo").textContent = tf("noteSealedInfo", { ttl: ttlLabel(ttl) });
    $("noteCompose").hidden = true;
    $("noteSealed").hidden = false;
    noteErr("");
  } catch {
    noteErr(t("noteErrNet"));
  } finally {
    $("noteSeal").disabled = false;
  }
};
$("noteCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("noteCodeShow").textContent); } catch { /* ignore */ }
  $("noteCopyLabel").textContent = t("copied");
  setTimeout(() => ($("noteCopyLabel").textContent = t("codeCopy")), 1500);
};
$("noteDone").onclick = () => {
  $("noteCodeShow").textContent = "";
  show("home");
};

// Открыть записку по коду. "ok" — показана, "none" — нет такой, "bad" — повреждена, "net" — сервер недоступен.
async function openNote(key) {
  let r;
  try {
    r = await fetch(`/note/${await noteIdFor(key)}`, { method: "POST" });
  } catch {
    return "net";
  }
  if (r.status === 404) return "none";
  if (!r.ok) return "net";
  let payload;
  try {
    const { ct } = await r.json();
    payload = await unseal(await noteKeyFor(key), ct);
  } catch {
    return "bad";
  }
  showNote(payload);
  return "ok";
}

function showNote(p) {
  closeNote();
  const box = $("noteReadText");
  box.replaceChildren();
  renderText(box, typeof p.text === "string" ? p.text.slice(0, 10000) : "");
  const img = $("noteReadImg");
  img.hidden = true;
  if (p.img && typeof p.img.b64 === "string") {
    try {
      const mime = safeMime(p.img.mime);
      if (/^image\//.test(mime)) {
        const url = URL.createObjectURL(new Blob([fromB64u(p.img.b64)], { type: mime }));
        noteView = { url };
        img.src = url;
        img.hidden = false;
      }
    } catch { /* битая картинка — показываем только текст */ }
  }
  noteView = noteView || {};
  $("noteCompose").hidden = true;
  $("noteSealed").hidden = true;
  $("noteRead").hidden = false;
  show("note");
  sounds.msg();
}

function closeNote() {
  if (noteView?.url) URL.revokeObjectURL(noteView.url);
  noteView = null;
  $("noteReadText").replaceChildren();
  $("noteReadImg").removeAttribute("src");
  $("noteReadImg").hidden = true;
}

const disarmNoteBurn = holdToBurn($("noteBurn"), $("noteBurnLabel"), {
  canBurn: () => !!noteView && !$("note").classList.contains("burning"),
  onBurn: () => {
    fireUp($("note"));
    setTimeout(() => {
      closeNote();
      disarmNoteBurn();
      $("note").classList.remove("burning");
      $("note").querySelector(".embers").replaceChildren();
      $("endTitle").textContent = t("endNoteBurned");
      $("endStats").hidden = true;
      show("end");
    }, 1700);
  },
});

// ---------- «проверь»: живой шифр на главной ----------
// Настоящее AES-256-GCM со случайным ключом, созданным для этой страницы. Текст никуда не отправляется.
let cipherKey = null;
async function cipherDemo() {
  const text = $("cipherIn").value;
  if (!text) return ($("cipherOut").textContent = "");
  if (!cipherKey) cipherKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = await seal(cipherKey, { text });
  if ($("cipherIn").value !== text) return; // уже напечатали дальше
  $("cipherOut").textContent = "s:" + (ct.length > 72 ? ct.slice(0, 72) + "…" : ct);
}
function closeCipher() {
  $("cipherPop").hidden = true;
}
$("checkBtn").onclick = () => {
  $("cipherPop").hidden = false;
  if (!$("cipherIn").value) $("cipherIn").value = t("cipherSample");
  cipherDemo();
  $("cipherIn").focus();
  $("cipherIn").select();
};
$("cipherClose").onclick = closeCipher;
$("cipherIn").addEventListener("input", cipherDemo);
document.addEventListener("click", (e) => {
  if (!$("cipherPop").hidden && !$("cipherPop").contains(e.target) && e.target !== $("checkBtn")) closeCipher();
});

// ---------- клавиатура на телефоне (iOS не уменьшает окно сам) ----------
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? Math.round(vv.height) : window.innerHeight;
  document.documentElement.style.setProperty("--vvh", `${h}px`);
  if (S?.admitted) scrollDown();
}
window.visualViewport?.addEventListener("resize", fitViewport);
addEventListener("resize", fitViewport);
fitViewport();

// ---------- запуск ----------
applyLang();
refreshComposer();
document.body.classList.add("home");

// Открыть комнату по ссылке с ключом (при загрузке или если ссылку вставили в адресную строку уже открытой вкладки).
function openFromHash() {
  const m = location.hash.match(LINK_RE);
  if (location.hash) history.replaceState(null, "", "/"); // убираем ключ из адресной строки и истории
  if (!m && !location.hash) return;
  let key = null;
  try {
    key = m ? fromB64u(m[2]) : null;
  } catch { /* ignore */ }
  if (key && key.length === 32 && !S) enterRoom({ name: m[1], linkKey: key, creator: false });
  else if (!S) {
    $("endTitle").textContent = t("endBad");
    $("endStats").hidden = true;
    show("end");
  }
}
addEventListener("hashchange", openFromHash);
openFromHash();
