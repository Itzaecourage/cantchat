// Прямое соединение браузер↔браузер (WebRTC).
// Служебные данные соединения идут через уже зашифрованный канал комнаты,
// поэтому подменить собеседника по дороге нельзя.
// relayOnly: режим «скрыть мой IP» — соединение идёт только через TURN-релей,
// собеседник видит адрес релея, а не твой.

export class Peer {
  constructor({ polite, iceServers, relayOnly, signal, onTrack, onState, onChannel }) {
    this.polite = polite;
    this.signal = signal;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.closed = false;

    const pc = (this.pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      iceTransportPolicy: relayOnly ? "relay" : "all",
    }));

    pc.onnegotiationneeded = async () => {
      // Первый offer делает только хозяин («невежливая» сторона): иначе оба шлют offer
      // одновременно, Chrome откатывает один из них и после отката не собирает ICE-кандидаты.
      if (this.polite && !pc.remoteDescription) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        signal({ description: pc.localDescription.toJSON() });
      } catch (e) {
        console.warn("negotiation", e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) signal({ candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => onTrack?.(e);
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === "failed") pc.restartIce();
      onState?.(pc.connectionState);
    };
    // Сторож: если переговоры закончились, а соединения всё нет — хозяин перезапускает ICE.
    pc.onsignalingstatechange = () => {
      if (this.closed) return;
      clearTimeout(this.watch);
      if (pc.signalingState === "stable" && !this.polite) {
        this.watch = setTimeout(() => {
          if (this.closed || this.restarts >= 3) return;
          if (["new", "connecting"].includes(pc.connectionState) && pc.signalingState === "stable") {
            this.restarts = (this.restarts || 0) + 1;
            pc.restartIce();
          }
        }, 5000);
      }
    };

    // Канал для файлов: создаётся с обеих сторон одинаково, без лишних переговоров.
    this.dc = pc.createDataChannel("cant", { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = "arraybuffer";
    this.dc.bufferedAmountLowThreshold = 1 << 20;
    onChannel?.(this.dc);
    // Chrome иногда «теряет» событие open у заранее согласованного канала:
    // readyState уже open, а обработчик не вызван. Подстраховываемся опросом.
    let seen = false;
    this.dc.addEventListener("open", () => (seen = true));
    const poll = setInterval(() => {
      if (this.closed || this.dc.readyState === "closed") return clearInterval(poll);
      if (this.dc.readyState === "open") {
        clearInterval(poll);
        if (!seen) {
          seen = true;
          this.dc.dispatchEvent(new Event("open"));
        }
      }
    }, 150);
  }

  // «Вежливое» согласование: если оба начали одновременно, гость уступает.
  async handle({ description, candidate }) {
    const pc = this.pc;
    if (this.closed) return;
    try {
      if (description) {
        const collision =
          description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          this.signal({ description: pc.localDescription.toJSON() });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          if (!this.ignoreOffer) console.warn("ice", e);
        }
      }
    } catch (e) {
      console.warn("rtc", e);
    }
  }

  get open() {
    return this.dc.readyState === "open";
  }

  // Каким путём идёт соединение: "direct" (напрямую) или "relay" (через TURN).
  async pathKind() {
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      for (const r of stats.values()) {
        if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      }
      if (!pair) {
        for (const r of stats.values()) {
          if (r.type === "candidate-pair" && (r.selected || r.nominated) && r.state === "succeeded") pair = r;
        }
      }
      if (!pair) return "direct";
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
    } catch {
      return "direct";
    }
  }

  // Самое большое сообщение, которое канал гарантированно пропустит.
  get maxMessage() {
    const m = this.pc.sctp?.maxMessageSize;
    return Number.isFinite(m) && m > 0 ? m : 65536;
  }

  close() {
    this.closed = true;
    clearTimeout(this.watch);
    try {
      this.dc.close();
    } catch { /* ignore */ }
    try {
      this.pc.close();
    } catch { /* ignore */ }
  }
}
