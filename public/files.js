// Передача файлов, фото и голосовых.
// Если прямое соединение готово, файл идёт браузер↔браузер и вообще не касается сервера.
// Если нет, файл режется на кусочки, каждый шифруется и проходит через сервер как шум.

import { toB64u, fromB64u } from "./crypto.js";

const DC_CHUNK = 60 * 1024; // + 8 байт заголовка < 64 КБ: безопасно для всех браузеров
const WS_CHUNK = 24 * 1024;
export const MAX_DIRECT = 1024 * 1024 * 1024; // 1 ГБ напрямую
export const MAX_RELAY = 50 * 1024 * 1024; // 50 МБ через сервер

// Сколько получатель может принять в память, не рискуя уронить вкладку.
// Файл целиком живёт в оперативной памяти до сохранения, поэтому на телефонах лимит ниже.
export function receiveLimit() {
  const mem = navigator.deviceMemory; // есть только в Chrome
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (Number.isFinite(mem)) return Math.min(MAX_DIRECT, Math.max(128, Math.floor(mem * 192)) * 1024 * 1024);
  return (coarse ? 384 : 768) * 1024 * 1024;
}

const SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(webm|mp4|ogg|mpeg|aac|wav|x-m4a))$/;

export function safeMime(m) {
  return typeof m === "string" && SAFE_TYPES.test(m) ? m : "application/octet-stream";
}

export function safeName(n) {
  const s = String(n || "file").replace(/[\\/:*?"<>|\u0000-\u001f​-‏‪-‮]/g, "_").slice(0, 120);
  return s || "file";
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FileHub {
  // dc():   канал прямого соединения или null
  // send(): отправка зашифрованного сообщения через сервер (возвращает Promise)
  // relayReady(): Promise, который ждёт, пока сервер готов принять следующий кусок
  // on: { meta(meta, mine, blob?), progress(id, frac), done(id, blob), fail(id, why) }
  constructor({ dc, send, relayReady, on }) {
    Object.assign(this, { dc, send, relayReady, on });
    this.rx = new Map();
    this.tx = new Map();
    this.stopped = false;
  }

  async sendFile(file, extra = {}) {
    const channel = this.dc();
    const direct = channel && channel.readyState === "open";
    if (file.size > (direct ? MAX_DIRECT : MAX_RELAY)) {
      const e = new Error("too big");
      e.relay = !direct && file.size <= MAX_DIRECT;
      throw e;
    }
    const idBytes = crypto.getRandomValues(new Uint8Array(8));
    const id = hex(idBytes);
    const meta = {
      t: "file", id, name: safeName(file.name), size: file.size,
      mime: safeMime(file.type), ...extra,
    };
    const tx = { cancelled: false };
    this.tx.set(id, tx);
    this.on.meta(meta, true, file);

    let sent = 0;
    try {
      if (direct) {
        channel.send(JSON.stringify(meta));
        while (sent < file.size) {
          if (this.stopped || tx.cancelled || channel.readyState !== "open") throw new Error("closed");
          const part = new Uint8Array(await file.slice(sent, sent + DC_CHUNK).arrayBuffer());
          const frame = new Uint8Array(8 + part.length);
          frame.set(idBytes);
          frame.set(part, 8);
          if (channel.bufferedAmount > 8 * DC_CHUNK * 16) {
            await new Promise((r) => {
              channel.addEventListener("bufferedamountlow", r, { once: true });
              setTimeout(r, 2000);
            });
          }
          channel.send(frame);
          sent += part.length;
          this.on.progress(id, sent / file.size);
        }
      } else {
        await this.send(meta);
        while (sent < file.size) {
          if (this.stopped || tx.cancelled) throw new Error("closed");
          await this.relayReady();
          const part = new Uint8Array(await file.slice(sent, sent + WS_CHUNK).arrayBuffer());
          await this.send({ t: "chunk", id, d: toB64u(part) });
          sent += part.length;
          this.on.progress(id, sent / file.size);
        }
      }
      if (file.size === 0) this.on.progress(id, 1);
    } catch {
      if (!tx.cancelled) this.on.fail(id, "send");
    } finally {
      this.tx.delete(id);
    }
    return id;
  }

  // Получатель отказался (например, файл не влезает в память его телефона).
  onReject(id, why) {
    const tx = this.tx.get(id);
    if (tx) {
      tx.cancelled = true;
      this.on.fail(id, why || "rejected");
    }
  }

  // ---- приём ----
  onMeta(m) {
    if (!m || typeof m.id !== "string" || !/^[a-f0-9]{16}$/.test(m.id)) return null;
    const size = Number(m.size);
    if (!(size >= 0 && size <= MAX_DIRECT)) return null;
    if (size > receiveLimit()) return { reject: m.id, why: "memory" };
    const meta = { ...m, size, name: safeName(m.name), mime: safeMime(m.mime) };
    this.rx.set(m.id, { meta, parts: [], got: 0 });
    this.on.meta(meta, false);
    if (size === 0) this.finish(m.id);
    return null;
  }

  onChunk(id, bytes) {
    const r = this.rx.get(id);
    if (!r) return;
    r.parts.push(bytes);
    r.got += bytes.length;
    if (r.got > r.meta.size) {
      this.rx.delete(id);
      this.on.fail(id, "corrupt");
      return;
    }
    this.on.progress(id, r.got / Math.max(1, r.meta.size));
    if (r.got === r.meta.size) this.finish(id);
  }

  onRelayChunk(m) {
    if (typeof m.id !== "string" || typeof m.d !== "string") return;
    try {
      this.onChunk(m.id, fromB64u(m.d));
    } catch { /* повреждённый кусок */ }
  }

  onChannelMessage(e) {
    if (typeof e.data === "string") {
      try {
        const m = JSON.parse(e.data);
        if (m.t === "file") {
          const r = this.onMeta(m);
          if (r?.reject) this.send({ t: "file-reject", id: r.reject, why: r.why });
        }
      } catch { /* ignore */ }
      return;
    }
    const u = new Uint8Array(e.data);
    if (u.length < 8) return;
    this.onChunk(hex(u.subarray(0, 8)), u.slice(8));
  }

  finish(id) {
    const r = this.rx.get(id);
    if (!r) return;
    this.rx.delete(id);
    this.on.done(id, new Blob(r.parts, { type: r.meta.mime }));
  }

  stop() {
    this.stopped = true;
    this.rx.clear();
    for (const tx of this.tx.values()) tx.cancelled = true;
    this.tx.clear();
  }
}

export { sleep };
