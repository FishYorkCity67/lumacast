'use strict';
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const { FlvMuxer, AdtsParser, serializeTag, VIDEO } = require('./flv');

const toBuf = (u8) => (Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));

// Owns the per-canvas muxers and the single AAC encoder whose output is shared
// by every canvas, so all destinations carry the same audio.
class Engine extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.muxers = new Map();
    this.aac = null;
    this.running = false;
  }

  start(ffmpeg, cfg) {
    if (this.running) this.stop();
    this.ffmpeg = ffmpeg;
    this.cfg = cfg;
    this.muxers.clear();
    for (const c of cfg.canvases) {
      this.muxers.set(c.key, new FlvMuxer({
        key: c.key, width: c.width, height: c.height, fps: c.fps, videoKbps: c.kbps,
        audioKbps: cfg.audioKbps, replayMs: (cfg.replaySeconds || 0) * 1000,
      }));
    }
    this.audioFrames = 0;
    this.running = true;
    this._startAac();
  }

  _startAac() {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-c:a', 'aac', '-b:a', `${this.cfg.audioKbps}k`, '-flush_packets', '1', '-f', 'adts', 'pipe:1',
    ];
    const child = spawn(this.ffmpeg, args, { windowsHide: true });
    const parser = new AdtsParser((frame) => {
      const ts = (this.audioFrames++ * 1024) / 48 + (this.cfg.syncOffsetMs || 0);
      if (ts < 0) return;
      for (const m of this.muxers.values()) {
        if (!m.asc) m.setAudioConfig(parser.asc);
        m.pushAudio(ts, frame);
      }
    });
    child.stdout.on('data', (d) => parser.push(d));
    child.stderr.on('data', (d) => this.log('audio-encoder', d.toString().trim()));
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      if (this.aac === child && this.running) this.emit('fault', `Audio encoder stopped (code ${code})`);
    });
    this.aac = child;
  }

  video(key, data, ts, isKey, desc) {
    const m = this.muxers.get(key);
    if (!m) return;
    if (desc) m.setVideoConfig(toBuf(desc));
    m.pushVideo(ts, toBuf(data), isKey);
  }

  audio(pcm) {
    if (this.aac && this.aac.stdin.writable) this.aac.stdin.write(toBuf(pcm));
  }

  setReplay(seconds) {
    for (const m of this.muxers.values()) m.setReplay(seconds * 1000);
  }

  stop() {
    this.running = false;
    const aac = this.aac;
    this.aac = null;
    if (aac) {
      aac.stdin.end();
      setTimeout(() => { try { aac.kill(); } catch { /* gone */ } }, 1500);
    }
    this.muxers.clear();
  }
}

// One ffmpeg process per destination that relays the muxed FLV (-c copy) to
// an RTMP(S) ingest or a local file. Reconnects with backoff and drops frames
// up to the next keyframe when the network can't keep up.
class Output extends EventEmitter {
  constructor(opts, engine, ffmpeg, log) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.kind = opts.kind || 'rtmp';
    this.canvas = opts.canvas || 'h';
    this.url = opts.url;
    this.file = opts.file;
    this.files = opts.file ? [opts.file] : [];
    this.oldChildren = new Set();
    this.secret = opts.secret || '';
    this.engine = engine;
    this.ffmpeg = ffmpeg;
    this.log = log;
    this.status = 'idle';
    this.error = '';
    this.reconnects = 0;
    this.attempt = 0;
    this.dropped = 0;
    this.bytesOut = 0;
    this._statBytes = 0;
    this._statAt = Date.now();
    this.child = null;
  }

  start() {
    this.wanted = true;
    this.startedAt = Date.now();
    this._spawn();
  }

  _clean(text) {
    let t = String(text).trim();
    if (this.secret) t = t.split(this.secret).join('••••');
    return t.split(/\r?\n/).filter(Boolean).pop() || '';
  }

  _setStatus(status, error) {
    if (this.status === status && (error === undefined || error === this.error)) return;
    this.status = status;
    if (error !== undefined) this.error = error;
    this.emit('status', this.status, this.error);
  }

  _spawn() {
    const muxer = this.engine.muxers.get(this.canvas);
    if (!muxer) {
      this.wanted = false;
      this._setStatus('error', 'Canvas is not being encoded');
      return;
    }
    this.muxer = muxer;
    const kbps = (muxer.meta.videodatarate || 6000) + (muxer.meta.audiodatarate || 160);
    this.highWater = this.kind === 'record' ? 256 * 1024 * 1024 : Math.round((kbps * 1000) / 8 * 2.5);
    this.lowWater = Math.round(this.highWater / 4);
    this.dropping = false;

    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '1',
      '-analyzeduration', '1000000', '-f', 'flv', '-i', 'pipe:0', '-map', '0', '-c', 'copy',
    ];
    if (this.kind === 'record') args.push('-f', 'matroska', '-y', this.file);
    else args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', this.url);

    const child = spawn(this.ffmpeg, args, { windowsHide: true });
    this.child = child;
    this._setStatus(this.reconnects ? 'reconnecting' : 'connecting', '');
    child.stdin.on('error', () => {});
    let progressBuf = '';
    child.stdout.on('data', (d) => {
      progressBuf += d.toString();
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop();
      for (const line of lines) {
        const m = /^total_size=(\d+)/.exec(line.trim());
        if (m && Number(m[1]) > 0 && this.status !== 'live' && this.child === child) {
          this.attempt = 0;
          this._setStatus('live', '');
        }
      }
    });
    child.stderr.on('data', (d) => {
      const msg = this._clean(d);
      if (msg) {
        this.error = msg;
        this.log(this.name, msg);
      }
    });
    child.on('error', (err) => this.log(this.name, String(err)));
    child.on('exit', (code) => this._onExit(child, code));
    this.sink = muxer.addSink({ onInit: (m) => this._write(m.init(0)), onTag: (t) => this._onTag(t) });
  }

  _write(buf) {
    if (!this.child || !this.child.stdin.writable) return;
    this.bytesOut += buf.length;
    this.child.stdin.write(buf);
    if (this.kind === 'record' && this.status !== 'live') this._setStatus('live', '');
  }

  _onTag(t) {
    if (!this.child) return;
    if (this.kind === 'record' && t.config && t.type === VIDEO) {
      this._rotate();
      return;
    }
    if (!t.config) {
      const queued = this.child.stdin.writableLength;
      if (this.dropping) {
        if (t.type === VIDEO && t.key && queued < this.lowWater) {
          this.dropping = false;
        } else {
          if (t.type === VIDEO) this.dropped++;
          return;
        }
      } else if (queued > this.highWater) {
        this.dropping = true;
        if (t.type === VIDEO) this.dropped++;
        this.emit('congestion');
        return;
      }
    }
    this._write(serializeTag(t.type, t.ts - this.sink.base, t.payload));
  }

  // A recording can't change SPS/PPS mid-file, so a new encoder configuration
  // (e.g. GPU -> CPU fallback) closes this file and continues in a new part.
  _rotate() {
    const child = this.child;
    if (child) {
      this.muxer.removeSink(this.sink);
      this.oldChildren.add(child);
      child.once('exit', () => this.oldChildren.delete(child));
      this.child = null;
      child.stdin.end();
    }
    this.segment = (this.segment || 1) + 1;
    this.file = this.files[0].replace(/\.mkv$/i, ` (part ${this.segment}).mkv`);
    this.files.push(this.file);
    this.log(this.name, `encoder changed, continuing in ${this.file}`);
    this._spawn();
  }

  _onExit(child, code) {
    if (child !== this.child) return;
    this.child = null;
    if (this.muxer) this.muxer.removeSink(this.sink);
    if (!this.wanted) {
      this._setStatus('offline');
      this.emit('closed', code);
      return;
    }
    if (this.kind === 'record') {
      this.wanted = false;
      this._setStatus('error', this.error || `ffmpeg exited (${code})`);
      this.emit('closed', code);
      return;
    }
    this.reconnects++;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.attempt++, 4));
    this._setStatus('reconnecting', this.error || `Connection lost (${code})`);
    this.retryTimer = setTimeout(() => {
      if (this.wanted && this.engine.running) this._spawn();
    }, delay);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    const child = this.child;
    if (!child) {
      this._setStatus('offline');
      this.emit('closed', 0);
      return;
    }
    if (this.muxer) this.muxer.removeSink(this.sink);
    child.stdin.end();
    const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 6000);
    child.once('exit', () => clearTimeout(killer));
  }

  closed() {
    const waits = [...this.oldChildren].map((c) => new Promise((r) => c.once('exit', r)));
    if (this.child || this.wanted) waits.push(new Promise((resolve) => this.once('closed', resolve)));
    return Promise.all(waits);
  }

  stats() {
    const now = Date.now();
    const dt = Math.max(0.25, (now - this._statAt) / 1000);
    const kbps = ((this.bytesOut - this._statBytes) * 8) / 1000 / dt;
    this._statBytes = this.bytesOut;
    this._statAt = now;
    const queued = this.child ? this.child.stdin.writableLength : 0;
    const rate = this.muxer ? (this.muxer.meta.videodatarate || 6000) + (this.muxer.meta.audiodatarate || 160) : 6000;
    return {
      id: this.id, name: this.name, kind: this.kind, canvas: this.canvas, status: this.status, error: this.error,
      kbps: Math.round(kbps), dropped: this.dropped, reconnects: this.reconnects,
      queueMs: Math.round((queued * 8) / rate), bytes: this.bytesOut,
      uptime: this.startedAt ? now - this.startedAt : 0, file: this.file,
    };
  }
}

function runFfmpeg(ffmpeg, args, input) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => resolve({ ok: false, error: String(e) }));
    child.on('exit', (code) => resolve({ ok: code === 0, error: err.trim().split(/\r?\n/).pop() || '' }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function remuxToMp4(ffmpeg, src, dst) {
  const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0', '-c', 'copy', '-movflags', '+faststart', dst]);
  if (r.ok) {
    try { fs.unlinkSync(src); } catch { /* keep the mkv */ }
    return dst;
  }
  return src;
}

async function writeClip(ffmpeg, flv, dst) {
  return runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'flv', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-movflags', '+faststart', dst], flv);
}

module.exports = { Engine, Output, remuxToMp4, writeClip };
