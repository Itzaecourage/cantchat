// Вся криптография cant.chat. Только встроенный в браузер WebCrypto, без сторонних библиотек.
//
// Схема:
// 1. linkKey — 32 случайных байта, живут только в ссылке после «#».
// 2. roomId = SHA-256(linkKey) — по нему сервер находит комнату, не зная ключа.
// 3. wrapKey = HKDF(linkKey) — им шифруется «рукопожатие», так что сервер не может
//    подменить собеседника (атака «человек посередине»).
// 4. Каждый участник создаёт одноразовую пару ключей ECDH P-256. Общий секрет
//    + linkKey → sessionKey (AES-256-GCM). Даже если ссылка позже утечёт,
//    записанную переписку расшифровать не получится.
// 5. Четыре эмодзи — отпечаток обоих ключей. Совпали у обоих = между вами никого нет.

import { EMOJI } from "./words.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function roomIdFor(linkKey) {
  const h = await sha256(concat(enc.encode("cant.chat/room:"), linkKey));
  return [...h.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hkdf(ikm, salt, info) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function wrapKeyFor(linkKey) {
  return hkdf(linkKey, new Uint8Array(32), "cant.chat/wrap/v1");
}

// Записки: ключ шифрования и идентификатор на сервере выводятся из ключа кода (PBKDF2, см. code.js).
// Идентификатор — хеш с другим префиксом, чем у комнат, поэтому один код не может «попасть» в оба.
export function noteKeyFor(codeKey) {
  return hkdf(codeKey, new Uint8Array(32), "cant.chat/note/v1");
}

export async function noteIdFor(codeKey) {
  const h = await sha256(concat(enc.encode("cant.chat/note:"), codeKey));
  return [...h.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function seal(key, obj) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))),
  );
  return toB64u(concat(iv, ct));
}

export async function unseal(key, str) {
  const b = fromB64u(str);
  if (b.length < 13) throw new Error("short");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12));
  return JSON.parse(dec.decode(pt));
}

export async function newIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, pub };
}

export async function deriveSession(identity, peerPub, linkKey) {
  if (!(peerPub instanceof Uint8Array) || peerPub.length !== 65) throw new Error("bad key");
  const peerKey = await crypto.subtle.importKey(
    "raw",
    peerPub,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, identity.privateKey, 256),
  );
  const [a, b] = sortPair(identity.pub, peerPub);
  const key = await hkdf(shared, linkKey, "cant.chat/session/v1");
  const fp = await sha256(concat(enc.encode("cant.chat/verify:"), linkKey, a, b));
  const emoji = [0, 1, 2, 3].map((i) => EMOJI[fp[i] % EMOJI.length]);
  return { key, emoji };
}

function sortPair(x, y) {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? [x, y] : [y, x];
  }
  return [x, y];
}

export function sameBytes(x, y) {
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
