// Негромкие звуки, синтезируются на лету: никаких аудиофайлов.

let ctx = null;

function ac() {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

export function unlockAudio() {
  ac();
}

// Один общий AudioContext на всё приложение: звуки, эффекты голоса, запись.
// Его «разблокирует» первое касание, поэтому iOS потом не молчит.
export function audioContext() {
  return ac();
}

function tone(freq, dur, when = 0, vol = 0.07, type = "sine") {
  const c = ac();
  if (!c || c.state !== "running") return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = c.currentTime + when;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const sounds = {
  msg() {
    tone(880, 0.12);
    tone(1320, 0.1, 0.07, 0.04);
  },
  knock() {
    tone(220, 0.09, 0, 0.18, "triangle");
    tone(220, 0.09, 0.17, 0.18, "triangle");
  },
  burn() {
    tone(140, 0.9, 0, 0.06, "sawtooth");
    tone(90, 1.2, 0.1, 0.05, "sawtooth");
  },
  end() {
    tone(520, 0.15);
    tone(390, 0.25, 0.12);
  },
};

let ringTm = null;
export function startRing(kind) {
  stopRing();
  const play =
    kind === "in"
      ? () => {
          tone(660, 0.22, 0, 0.09);
          tone(880, 0.3, 0.26, 0.09);
          navigator.vibrate?.([250, 150, 250]);
        }
      : () => tone(440, 0.9, 0, 0.04);
  play();
  ringTm = setInterval(play, kind === "in" ? 2200 : 3000);
}

export function stopRing() {
  clearInterval(ringTm);
  ringTm = null;
}
