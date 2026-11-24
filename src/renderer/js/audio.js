// Web Audio mixer: desktop loopback, microphones and media sources run through
// gate -> compressor -> fader -> mute into a limited master bus, which a PCM tap
// worklet streams to the AAC encoder in the main process.
import { Emitter, gainToDb } from './util.js';

const deviceKey = (cfg) => `${cfg.kind}|${cfg.deviceId || ''}|${cfg.noiseSuppression ? 1 : 0}`;

export class AudioEngine extends Emitter {
  constructor() {
    super();
    this.channels = new Map();
    this.ctx = null;
    this.tapOn = false;
    this.alertMonitor = false;
  }

  async init() {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('js/worklets.js');
    this.master = ctx.createGain();
    this.master.channelCount = 2;
    this.master.channelCountMode = 'explicit';
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    this.master.connect(this.limiter);
    this.tap = new AudioWorkletNode(ctx, 'lc-pcm-tap', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.limiter.connect(this.tap);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    this.tap.connect(silent).connect(ctx.destination);
    this.monitorBus = ctx.createGain();
    this.monitorBus.connect(ctx.destination);
    this.masterMeter = this._meter(this.limiter);
    this.tap.port.onmessage = (e) => this._onPcm(e.data);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', resume);
    setInterval(resume, 3000);
  }

  _meter(node) {
    const split = this.ctx.createChannelSplitter(2);
    node.connect(split);
    const analysers = [0, 1].map((i) => {
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      split.connect(an, i);
      return an;
    });
    return { analysers, buf: new Float32Array(1024), cache: [-100, -100], at: 0 };
  }

  readMeter(m) {
    const now = performance.now();
    if (now - m.at < 12) return m.cache;
    m.at = now;
    m.cache = m.analysers.map((an) => {
      an.getFloatTimeDomainData(m.buf);
      let p = 0;
      for (let i = 0; i < m.buf.length; i++) {
        const a = Math.abs(m.buf[i]);
        if (a > p) p = a;
      }
      return gainToDb(p);
    });
    return m.cache;
  }

  levels(id) {
    if (id === 'master') return this.readMeter(this.masterMeter);
    const ch = this.channels.get(id);
    return ch ? this.readMeter(ch.meter) : [-100, -100];
  }

  level(id) {
    const [l, r] = this.levels(id);
    return Math.max(l, r);
  }

  _createChannel(id, name, kind) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const gate = new AudioWorkletNode(ctx, 'lc-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const compIn = ctx.createGain();
    const directIn = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.6;
    const fader = ctx.createGain();
    fader.channelCount = 2;
    fader.channelCountMode = 'explicit';
    fader.channelInterpretation = 'speakers';
    const mute = ctx.createGain();
    const monitor = ctx.createGain();
    monitor.gain.value = 0;
    input.connect(gate);
    gate.connect(compIn).connect(comp).connect(makeup).connect(fader);
    gate.connect(directIn).connect(fader);
    fader.connect(mute);
    mute.connect(this.master);
    mute.connect(monitor).connect(this.monitorBus);
    const ch = { id, name, kind, input, gate, compIn, directIn, comp, fader, mute, monitor, meter: this._meter(mute), stream: null, srcNode: null, deviceKey: '', error: '' };
    this.channels.set(id, ch);
    return ch;
  }

  _stopStream(ch) {
    if (ch.srcNode) {
      try { ch.srcNode.disconnect(); } catch { /* already */ }
      ch.srcNode = null;
    }
    if (ch.stream) {
      ch.stream.getTracks().forEach((t) => t.stop());
      ch.stream = null;
    }
  }

  async _openStream(ch, cfg) {
    this._stopStream(ch);
    let stream;
    if (cfg.kind === 'desktop') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 64, maxHeight: 64, maxFrameRate: 1 } },
      });
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: cfg.deviceId && cfg.deviceId !== 'default' ? { exact: cfg.deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: !!cfg.noiseSuppression,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
        video: false,
      });
    }
    ch.stream = stream;
    ch.srcNode = this.ctx.createMediaStreamSource(stream);
    ch.srcNode.connect(ch.input);
    ch.deviceKey = deviceKey(cfg);
    ch.error = '';
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => {
        if (ch.stream !== stream) return;
        ch.error = 'Device disconnected';
        this._stopStream(ch);
        this.emit('channel-ended', ch.id);
      };
    }
  }

  _apply(ch, cfg) {
    const t = this.ctx.currentTime;
    ch.fader.gain.setTargetAtTime(cfg.volume ?? 1, t, 0.03);
    ch.mute.gain.setTargetAtTime(cfg.muted ? 0 : 1, t, 0.015);
    ch.monitor.gain.setTargetAtTime(cfg.monitor ? 1 : 0, t, 0.03);
    const gate = cfg.gate || {};
    ch.gate.parameters.get('enabled').value = gate.enabled ? 1 : 0;
    ch.gate.parameters.get('threshold').value = gate.threshold ?? -48;
    ch.compIn.gain.value = cfg.compressor ? 1 : 0;
    ch.directIn.gain.value = cfg.compressor ? 0 : 1;
    ch.name = cfg.name;
  }

  // Inputs from state.audioInputs (desktop + microphones).
  async setInput(cfg) {
    let ch = this.channels.get(cfg.id);
    if (!cfg.enabled) {
      if (ch) this.remove(cfg.id);
      return;
    }
    if (!ch) ch = this._createChannel(cfg.id, cfg.name, cfg.kind);
    if (!ch.stream || ch.deviceKey !== deviceKey(cfg)) {
      try {
        await this._openStream(ch, cfg);
      } catch (err) {
        ch.error = String(err.message || err);
        this.emit('channel-error', cfg.id, ch.error);
      }
    }
    this._apply(ch, cfg);
  }

  // Media sources (video files) route their element audio through the mixer.
  attachElement(id, name, el, cfg) {
    let ch = this.channels.get(id);
    if (!ch) ch = this._createChannel(id, name, 'media');
    if (ch.element !== el) {
      if (ch.srcNode) try { ch.srcNode.disconnect(); } catch { /* ok */ }
      ch.srcNode = this.ctx.createMediaElementSource(el);
      ch.srcNode.connect(ch.input);
      ch.element = el;
    }
    this._apply(ch, { name, volume: 1, muted: false, monitor: false, gate: { enabled: false }, compressor: false, ...cfg });
    return ch;
  }

  updateChannel(id, cfg) {
    const ch = this.channels.get(id);
    if (ch) this._apply(ch, { ...cfg, name: cfg.name || ch.name });
  }

  remove(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    this._stopStream(ch);
    for (const n of [ch.input, ch.gate, ch.compIn, ch.directIn, ch.comp, ch.fader, ch.mute, ch.monitor]) {
      try { n.disconnect(); } catch { /* ok */ }
    }
    this.channels.delete(id);
  }

  chime(kind) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = 0.22;
    out.connect(this.master);
    if (this.alertMonitor) out.connect(this.monitorBus);
    const notes = {
      sub: [659.3, 880, 1318.5], gift: [784, 987.8, 1318.5, 1568], raid: [392, 523.3, 659.3, 784, 1046.5],
      cheer: [880, 1174.7, 1568], superchat: [523.3, 659.3, 784, 1046.5], member: [587.3, 880, 1174.7],
    }[kind] || [523.3, 784, 1046.5];
    notes.forEach((f, i) => {
      const at = t + i * 0.085;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.7, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + 1);
    });
    setTimeout(() => out.disconnect(), 2500);
  }

  // ---- PCM tap with clock-drift correction -------------------------------------
  startTap(t0, sink) {
    this.t0 = t0;
    this.sent = 0;
    this.sink = sink;
    this.errEma = null;
    this.baseSum = 0;
    this.baseN = 0;
    this.tap.port.postMessage({ on: true });
    this.tapOn = true;
  }

  stopTap() {
    if (this.tap) this.tap.port.postMessage({ on: false });
    this.tapOn = false;
    this.sink = null;
  }

  _onPcm(buf) {
    if (!this.tapOn || !this.sink) return;
    const frames = buf.length / 2;
    const expected = ((performance.now() - this.t0) / 1000) * 48000;
    let err = this.sent + frames - expected;
    if (this.baseN < 100) {
      this.baseSum += err;
      this.baseN++;
    }
    err -= this.baseSum / this.baseN;
    this.errEma = this.errEma === null ? err : this.errEma * 0.98 + err * 0.02;
    let out = buf;
    if (this.errEma < -4800) {
      // audio clock stalled (device change): pad with silence to stay in sync
      const pad = Math.min(48000, Math.round(-this.errEma));
      this.sink(new Float32Array(pad * 2));
      this.sent += pad;
      this.errEma += pad;
    } else if (this.errEma > 9600) {
      this.errEma -= frames;
      return;
    } else if (this.errEma > 240) {
      out = buf.slice(0, buf.length - 2);
      this.errEma -= 1;
    } else if (this.errEma < -240) {
      out = new Float32Array(buf.length + 2);
      out.set(buf);
      out[buf.length] = buf[buf.length - 2];
      out[buf.length + 1] = buf[buf.length - 1];
      this.errEma += 1;
    }
    this.sent += out.length / 2;
    this.sink(out);
  }
}
