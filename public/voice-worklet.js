// Изменение голоса в реальном времени. Работает прямо в браузере, звук никуда не уходит
// до того, как будет изменён.
// Режимы: off (без изменений), deep (низкий), high (высокий), robot (робот).

const RATIOS = { off: 1, deep: 0.72, high: 1.5, robot: 1 };

class CantVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "off";
    this.W = Math.round(sampleRate * 0.05); // окно 50 мс
    this.N = this.W * 2 + 16;
    this.buf = new Float32Array(this.N);
    this.w = 0;
    this.d = 0;
    this.phase = 0;
    this.port.onmessage = (e) => {
      if (e.data && RATIOS[e.data.mode] !== undefined) this.mode = e.data.mode;
    };
  }

  read(delay) {
    let p = this.w - delay;
    while (p < 0) p += this.N;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.buf[i % this.N];
    const b = this.buf[(i + 1) % this.N];
    return a + (b - a) * f;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0];
    if (!input) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const o = out[0];
    const ratio = RATIOS[this.mode];
    const W = this.W;

    for (let n = 0; n < input.length; n++) {
      const x = input[n];
      this.buf[this.w] = x;
      let y = x;

      if (ratio !== 1) {
        // две «головки» чтения, сдвинутые на пол-окна, с плавным перекрёстным затуханием
        this.d += 1 - ratio;
        if (this.d < 0) this.d += W;
        if (this.d >= W) this.d -= W;
        const d1 = this.d;
        const d2 = (this.d + W / 2) % W;
        const g1 = Math.sin((Math.PI * d1) / W);
        const g2 = Math.sin((Math.PI * d2) / W);
        y = this.read(d1 + 2) * g1 * g1 + this.read(d2 + 2) * g2 * g2;
      }

      if (this.mode === "robot") {
        this.phase += 55 / sampleRate;
        if (this.phase >= 1) this.phase -= 1;
        y = y * Math.sin(2 * Math.PI * this.phase) * 1.6;
      }

      o[n] = y;
      this.w = (this.w + 1) % this.N;
    }
    for (let c = 1; c < out.length; c++) out[c].set(o);
    return true;
  }
}

registerProcessor("cant-voice", CantVoice);
