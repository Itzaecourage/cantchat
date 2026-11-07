// Микрофон, камера, изменение голоса и запись голосовых сообщений.

import { audioContext } from "./sound.js";

export const FX_MODES = ["off", "deep", "high", "robot"];

let workletReady = null;

async function audioCtx() {
  const ctx = audioContext();
  if (!ctx) throw new Error("no audio");
  if (!workletReady) {
    workletReady = ctx.audioWorklet
      ? ctx.audioWorklet.addModule("/voice-worklet.js").then(() => true, () => false)
      : Promise.resolve(false);
  }
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  return ctx;
}

// Не даём экрану телефона погаснуть во время звонка.
let lock = null;
export async function keepAwake(on) {
  try {
    if (on && !lock && navigator.wakeLock) {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    lock = null;
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Пропускает микрофон через эффект. Исходный микрофон не останавливает.
export async function voicePipeline(micTrack, mode) {
  try {
    const c = await audioCtx();
    if (!(await workletReady)) return null;
    const src = c.createMediaStreamSource(new MediaStream([micTrack]));
    const node = new AudioWorkletNode(c, "cant-voice");
    const dest = c.createMediaStreamDestination();
    src.connect(node).connect(dest);
    node.port.postMessage({ mode });
    return {
      track: dest.stream.getAudioTracks()[0],
      setMode: (m) => node.port.postMessage({ mode: m }),
      stop() {
        try {
          src.disconnect();
          node.disconnect();
        } catch { /* ignore */ }
        stopStream(dest.stream);
      },
    };
  } catch {
    return null;
  }
}

export async function getMic() {
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return s.getAudioTracks()[0];
}

export async function getCam(facing = "user") {
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  return s.getVideoTracks()[0];
}

export async function cameraCount() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 0;
  }
}

export const canRecord = () => typeof window.MediaRecorder === "function" && !!navigator.mediaDevices?.getUserMedia;
export const canShareScreen = () =>
  !!navigator.mediaDevices?.getDisplayMedia && !matchMedia("(pointer: coarse)").matches;

export async function startRecording(mode) {
  const mic = await getMic();
  const pipe = mode !== "off" ? await voicePipeline(mic, mode) : null;
  const track = pipe ? pipe.track : mic;
  const mime =
    ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((m) =>
      MediaRecorder.isTypeSupported?.(m),
    ) || "";
  const rec = new MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : {});
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = performance.now();
  rec.start(250);
  const cleanup = () => {
    pipe?.stop();
    mic.stop();
  };
  return {
    elapsed: () => (performance.now() - started) / 1000,
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          cleanup();
          resolve({
            blob: new Blob(chunks, { type: (rec.mimeType || mime || "audio/webm").split(";")[0] }),
            dur: (performance.now() - started) / 1000,
          });
        };
        rec.stop();
      }),
    cancel() {
      rec.onstop = cleanup;
      try {
        rec.stop();
      } catch {
        cleanup();
      }
    },
  };
}
