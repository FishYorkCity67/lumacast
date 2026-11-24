// Output controller: WebCodecs H.264 encoders per canvas + the PCM tap feed the
// main-process engine, which fans out to destinations, recordings and the
// replay buffer. Also handles adaptive bitrate on network congestion.
import { Emitter } from './util.js';
import { state, rt, verticalEnabled } from './state.js';

const LEVELS = [
  [0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760],
  [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600],
];

function avcCodec(profile, w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const level = (LEVELS.find(([, fs, rate]) => mbs <= fs && mbs * fps <= rate) || LEVELS[LEVELS.length - 1])[0];
  return `avc1.${profile}${level.toString(16).padStart(2, '0').toUpperCase()}`;
}

// 'auto' puts the main 16:9 canvas on the GPU encoder and the 9:16 canvas on
// the CPU encoder: Chromium imports every GPU frame on the GPU process main
// thread (~10 ms per 1080p frame), so two hardware sessions plus the UI starve it.
export function accelFor(key) {
  const mode = state.settings.video.encoder || 'auto';
  if (mode === 'hardware') return 'prefer-hardware';
  if (mode === 'software') return 'prefer-software';
  return key === 'h' ? 'prefer-hardware' : 'prefer-software';
}

async function pickConfig(w, h, fps, kbps, accelPref) {
  const accels = accelPref === 'prefer-software' ? ['prefer-software', 'no-preference'] : ['prefer-hardware', 'no-preference', 'prefer-software'];
  for (const hardwareAcceleration of accels) {
    for (const profile of ['6400', '4D40', '42E0']) {
      for (const bitrateMode of ['constant', 'variable']) {
        const cfg = {
          codec: avcCodec(profile, w, h, fps), width: w, height: h, bitrate: kbps * 1000, framerate: fps,
          hardwareAcceleration, latencyMode: 'realtime', bitrateMode, avc: { format: 'avc' },
        };
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return cfg;
        } catch { /* try next */ }
      }
    }
  }
  throw new Error('No H.264 encoder available on this PC');
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

class CanvasEncoder {
  constructor(key, canvas, cfg, onError, compositorCanvas) {
    this.key = key;
    this.canvas = canvas;
    this.cc = compositorCanvas;
    this.startedAt = performance.now();
    this.cfg = cfg;
    this.targetKbps = cfg.bitrate / 1000;
    this.kbps = this.targetKbps;
    this.interval = 1000 / cfg.framerate;
    this.lastFrameAt = 0;
    this.lastKey = -Infinity;
    this.frames = 0;
    this.outFrames = 0;
    this.dropped = 0;
    this.bytes = 0;
    this.lastDesc = null;
    this.slowWindows = 0;
    this.win = { at: performance.now(), frames: 0 };
    this.fps = 0;
    this.encoder = new VideoEncoder({ output: (c, md) => this.output(c, md), error: (e) => onError(this.key, e) });
    this.encoder.configure(cfg);
  }

  get hardware() { return this.cfg.hardwareAcceleration !== 'prefer-software'; }

  // Achieved output fps over 2 s windows; returns true when a hardware encoder
  // stays too slow for 5 windows in a row after its ~10 s warm-up.
  checkSpeed(now) {
    const dt = now - this.win.at;
    if (dt < 2000) return false;
    this.fps = ((this.outFrames - this.win.frames) * 1000) / dt;
    this.win = { at: now, frames: this.outFrames };
    if (now - this.startedAt < 12000) return false;
    if (this.fps < this.cfg.framerate * 0.7) this.slowWindows++;
    else this.slowWindows = 0;
    return this.hardware && this.slowWindows >= 5;
  }

  switchToSoftware() {
    this.cfg = { ...this.cfg, hardwareAcceleration: 'prefer-software' };
    this.slowWindows = 0;
    try {
      this.encoder.configure(this.cfg);
      this.forceKey = true;
    } catch (err) {
      console.error('software fallback failed', err);
    }
  }

  maybeEncode(now, t0) {
    if (this.cc.renderedAt !== now) return; // only freshly rendered frames
    this.lastFrameAt = now;
    if (this.encoder.state !== 'configured') return;
    if (this.encoder.encodeQueueSize > 6) {
      this.dropped++;
      return;
    }
    // constant-frame-rate timestamps: snap to the frame grid, never repeat a slot
    const slot = Math.max((this.lastSlot ?? -1) + 1, Math.round((now - t0) / this.interval));
    this.lastSlot = slot;
    const ts = Math.round(slot * this.interval * 1000);
    let frame;
    try {
      frame = new VideoFrame(this.canvas, { timestamp: ts });
    } catch (err) {
      this.dropped++;
      if (!this.warned) {
        this.warned = true;
        console.error('frame capture failed', err);
      }
      return;
    }
    const key = this.forceKey || ts - this.lastKey >= 2e6;
    if (key) {
      this.lastKey = ts;
      this.forceKey = false;
    }
    this.encoder.encode(frame, { keyFrame: key });
    frame.close();
    this.frames++;
  }

  output(chunk, md) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    let desc = null;
    const d = md && md.decoderConfig && md.decoderConfig.description;
    if (d) {
      const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      if (!this.lastDesc || !sameBytes(u8, this.lastDesc)) {
        desc = u8.slice();
        this.lastDesc = desc;
      }
    }
    if (!this.lastDesc) return; // nothing decodable without SPS/PPS
    this.bytes += chunk.byteLength;
    this.outFrames++;
    window.lc.send('engine:video', this.key, data, Math.round(chunk.timestamp / 1000), chunk.type === 'key', desc);
  }

  setBitrate(kbps) {
    kbps = Math.round(kbps);
    if (kbps === this.kbps) return;
    this.kbps = kbps;
    this.cfg = { ...this.cfg, bitrate: kbps * 1000 };
    try {
      this.encoder.configure(this.cfg);
      this.forceKey = true;
    } catch (err) {
      console.error('bitrate change failed', err);
    }
  }

  close() {
    try { this.encoder.close(); } catch { /* closed */ }
  }
}

export class OutputController extends Emitter {
  constructor(compositor, audio) {
    super();
    this.compositor = compositor;
    this.audio = audio;
    this.encoders = new Map();
    this.engine = false;
    this.starting = null;
    compositor.frameHooks.push((now) => this.onFrame(now));
    window.lc.on('outputs:congestion', (e) => this.onCongestion(e.canvas));
    window.lc.on('engine:fault', (msg) => this.emit('fault', msg));
    setInterval(() => this.recoverBitrate(), 10000);
  }

  get busy() { return rt.live || rt.recording || rt.replay; }

  activeCanvases() {
    return verticalEnabled() ? ['h', 'v'] : ['h'];
  }

  async ensureEngine() {
    if (this.engine) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const v = state.settings.video;
      const canvases = this.activeCanvases().map((key) => ({
        key, width: v[key].width, height: v[key].height, fps: v[key].fps, kbps: v[key].kbps,
      }));
      const configs = [];
      for (const c of canvases) configs.push(await pickConfig(c.width, c.height, c.fps, c.kbps, accelFor(c.key)));
      await window.lc.invoke('engine:start', {
        canvases,
        audioKbps: state.settings.audio.kbps,
        syncOffsetMs: state.settings.audio.syncOffsetMs || 0,
        replaySeconds: rt.replay ? state.settings.replay.seconds : 0,
      });
      this.t0 = performance.now();
      canvases.forEach((c, i) => {
        const cc = this.compositor.canvases[c.key];
        this.encoders.set(c.key, new CanvasEncoder(c.key, cc.el, configs[i], (key, err) => this.onEncoderError(key, err), cc));
      });
      this.encoderInfo = configs.map((c) => `${c.codec} ${c.hardwareAcceleration} ${c.bitrateMode}`).join(' · ');
      this.audio.startTap(this.t0, (pcm) => window.lc.send('engine:audio', pcm));
      this.engine = true;
      rt.engine = true;
      window.lc.invoke('power:block', true);
      window.lc.invoke('log', 'encoder', this.encoderInfo);
      this.emit('engine', true);
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stopEngineIfIdle() {
    if (this.busy || !this.engine) return;
    this.engine = false;
    rt.engine = false;
    this.audio.stopTap();
    for (const enc of this.encoders.values()) enc.close();
    this.encoders.clear();
    await window.lc.invoke('engine:stop');
    window.lc.invoke('power:block', false);
    this.emit('engine', false);
  }

  onFrame(now) {
    if (!this.engine) return;
    for (const enc of this.encoders.values()) {
      enc.maybeEncode(now, this.t0);
      if (enc.checkSpeed(now) && (state.settings.video.encoder || 'auto') === 'auto') {
        enc.switchToSoftware();
        this.emit('fallback', enc.key);
        window.lc.invoke('log', 'encoder', `${enc.key} hardware too slow (${enc.fps.toFixed(1)} fps), switched to software`);
      }
    }
  }

  onEncoderError(key, err) {
    console.error('encoder error', key, err);
    this.emit('fault', `Video encoder (${key === 'v' ? '9:16' : '16:9'}) failed: ${err.message || err}`);
  }

  canvasFor(dest) {
    return dest.canvas === 'v' && verticalEnabled() ? 'v' : 'h';
  }

  // ---- live ----------------------------------------------------------------------------
  async goLive(destinations) {
    await this.ensureEngine();
    rt.outputs = {};
    await window.lc.invoke('outputs:start', destinations.map((d) => this.destPayload(d)));
    rt.live = true;
    rt.liveStart = Date.now();
    this.emit('live', true);
  }

  async endLive() {
    await window.lc.invoke('outputs:stop');
    rt.live = false;
    this.emit('live', false);
    await this.stopEngineIfIdle();
  }

  destPayload(d) {
    return { id: d.id, name: d.name, server: d.server, key: d.key, canvas: this.canvasFor(d), engine: state.settings.rtmpEngine || 'native' };
  }

  async restartDestination(dest) {
    if (!rt.live) return;
    await window.lc.invoke('outputs:start', [this.destPayload(dest)]);
  }

  async stopDestination(id) {
    await window.lc.invoke('outputs:stop', [id]);
  }

  // ---- recording -------------------------------------------------------------------------
  async startRecording() {
    await this.ensureEngine();
    const r = state.settings.recording;
    const canvases = ['h'];
    if (r.vertical && verticalEnabled()) canvases.push('v');
    await window.lc.invoke('record:start', { canvases, folder: r.folder || rt.info.videosDir, remux: r.remux });
    rt.recording = true;
    rt.recStart = Date.now();
    this.emit('recording', true);
  }

  async stopRecording() {
    const files = await window.lc.invoke('record:stop');
    rt.recording = false;
    this.emit('recording', false, files);
    await this.stopEngineIfIdle();
    return files;
  }

  // ---- replay buffer -----------------------------------------------------------------------
  async setReplay(on) {
    if (on === rt.replay) return;
    rt.replay = on;
    if (on) {
      await this.ensureEngine();
      await window.lc.invoke('engine:replay', state.settings.replay.seconds);
    } else if (this.engine) {
      await window.lc.invoke('engine:replay', 0);
      await this.stopEngineIfIdle();
    }
    this.emit('replay', on);
  }

  async saveClip(label) {
    if (!rt.replay || !this.engine) return null;
    const canvases = this.activeCanvases();
    const files = await window.lc.invoke('replay:save', {
      canvases, folder: state.settings.recording.folder || rt.info.videosDir, seconds: state.settings.replay.seconds, label,
    });
    rt.clips.push(...files.map((f) => ({ file: f, at: Date.now(), label })));
    this.emit('clip', files, label);
    return files;
  }

  // ---- adaptive bitrate -------------------------------------------------------------------
  onCongestion(canvas) {
    if (!state.settings.video.adaptive) return;
    const enc = this.encoders.get(canvas);
    if (!enc) return;
    const floor = enc.targetKbps * 0.4;
    const next = Math.max(floor, enc.kbps * 0.75);
    if (next < enc.kbps - 1) {
      enc.setBitrate(next);
      enc.congestedAt = performance.now();
      this.emit('bitrate', canvas, enc.kbps, enc.targetKbps);
    }
  }

  recoverBitrate() {
    for (const [canvas, enc] of this.encoders) {
      if (enc.kbps >= enc.targetKbps) continue;
      if (performance.now() - (enc.congestedAt || 0) < 15000) continue;
      enc.setBitrate(Math.min(enc.targetKbps, enc.kbps * 1.15));
      this.emit('bitrate', canvas, enc.kbps, enc.targetKbps);
    }
  }

  encoderStats() {
    const out = {};
    for (const [k, e] of this.encoders) out[k] = { frames: e.frames, out: e.outFrames, fps: Math.round(e.fps * 10) / 10, dropped: e.dropped, kbps: e.kbps, target: e.targetKbps, hw: e.hardware };
    return out;
  }
}
