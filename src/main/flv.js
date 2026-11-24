'use strict';
// FLV muxing for the output engine. The renderer hands us H.264 (AVCC) chunks
// per canvas and the AAC encoder hands us ADTS frames; each canvas gets one
// FlvMuxer that interleaves both, fans tags out to sinks (RTMP pushers,
// recorders) and keeps a rolling replay buffer for instant clips.

const AUDIO = 8;
const VIDEO = 9;
const SCRIPT = 18;

const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);

function amfString(s) {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return Buffer.concat([len, body]);
}

function amfValue(v) {
  if (typeof v === 'number') {
    const b = Buffer.alloc(9);
    b[0] = 0;
    b.writeDoubleBE(v, 1);
    return b;
  }
  if (typeof v === 'boolean') return Buffer.from([1, v ? 1 : 0]);
  return Buffer.concat([Buffer.from([2]), amfString(String(v))]);
}

function onMetaData(meta) {
  const keys = Object.keys(meta);
  const head = Buffer.alloc(5);
  head[0] = 8; // ECMA array
  head.writeUInt32BE(keys.length, 1);
  const parts = [Buffer.from([2]), amfString('onMetaData'), head];
  for (const k of keys) parts.push(amfString(k), amfValue(meta[k]));
  parts.push(Buffer.from([0, 0, 9]));
  return Buffer.concat(parts);
}

function serializeTag(type, ts, payload) {
  ts = Math.max(0, Math.round(ts));
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(payload.length, 1, 3);
  head.writeUIntBE(ts & 0xffffff, 4, 3);
  head[7] = (ts >>> 24) & 0xff;
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(11 + payload.length);
  return Buffer.concat([head, payload, tail]);
}

const videoPayload = (key, data) => Buffer.concat([Buffer.from([key ? 0x17 : 0x27, 1, 0, 0, 0]), data]);
const videoConfigPayload = (avcC) => Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), avcC]);
const audioPayload = (data) => Buffer.concat([Buffer.from([0xaf, 1]), data]);
const audioConfigPayload = (asc) => Buffer.concat([Buffer.from([0xaf, 0]), asc]);

// Splits an ADTS byte stream (ffmpeg -f adts) into raw AAC frames.
class AdtsParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
    this.asc = null;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const b = this.buf;
    let off = 0;
    while (b.length - off >= 7) {
      if (b[off] !== 0xff || (b[off + 1] & 0xf6) !== 0xf0) { off++; continue; }
      const len = ((b[off + 3] & 3) << 11) | (b[off + 4] << 3) | (b[off + 5] >> 5);
      if (len < 7) { off++; continue; }
      if (b.length - off < len) break;
      const headerLen = (b[off + 1] & 1) ? 7 : 9;
      if (!this.asc) {
        const objectType = (b[off + 2] >> 6) + 1;
        const freqIndex = (b[off + 2] >> 2) & 0xf;
        const channels = ((b[off + 2] & 1) << 2) | (b[off + 3] >> 6);
        this.asc = Buffer.from([(objectType << 3) | (freqIndex >> 1), ((freqIndex & 1) << 7) | (channels << 3)]);
      }
      this.onFrame(Buffer.from(b.subarray(off + headerLen, off + len)));
      off += len;
    }
    this.buf = b.subarray(off);
  }
}

class FlvMuxer {
  constructor({ key, width, height, fps, videoKbps, audioKbps, replayMs = 0 }) {
    this.key = key;
    this.meta = {
      duration: 0, width, height, framerate: fps, videocodecid: 7, videodatarate: videoKbps,
      audiocodecid: 10, audiodatarate: audioKbps, audiosamplerate: 48000, audiosamplesize: 16,
      stereo: true, encoder: 'Lumacast',
    };
    this.avcC = null;
    this.asc = null;
    this.sinks = new Set();
    this.vq = [];
    this.aq = [];
    this.lastVideoTs = 0;
    this.lastAudioTs = 0;
    this.lastTs = 0;
    this.replayMs = replayMs;
    this.replay = [];
    this.videoFrames = 0;
  }

  get ready() { return !!(this.avcC && this.asc); }

  setReplay(ms) {
    this.replayMs = ms;
    if (!ms) this.replay = [];
  }

  setVideoConfig(avcC) {
    if (this.avcC && this.avcC.equals(avcC)) return;
    this.avcC = Buffer.from(avcC);
    this._broadcastConfig({ type: VIDEO, ts: this.lastTs, payload: videoConfigPayload(this.avcC), config: true });
  }

  setAudioConfig(asc) {
    if (this.asc && this.asc.equals(asc)) return;
    this.asc = Buffer.from(asc);
    this._broadcastConfig({ type: AUDIO, ts: this.lastTs, payload: audioConfigPayload(this.asc), config: true });
  }

  pushVideo(ts, data, key) {
    ts = Math.max(ts, this.lastVideoTs);
    this.lastVideoTs = ts;
    this.vq.push({ type: VIDEO, ts, payload: videoPayload(key, data), key });
    this._drain();
  }

  pushAudio(ts, data) {
    ts = Math.max(ts, this.lastAudioTs);
    this.lastAudioTs = ts;
    this.aq.push({ type: AUDIO, ts, payload: audioPayload(data) });
    this._drain();
  }

  // Emits tags in timestamp order; if one stream stalls (e.g. no audio yet)
  // the other is released after 700 ms so the stream never freezes.
  _drain() {
    const { vq, aq } = this;
    for (;;) {
      let t;
      if (vq.length && aq.length) t = vq[0].ts <= aq[0].ts ? vq.shift() : aq.shift();
      else if (vq.length && vq[vq.length - 1].ts - vq[0].ts > 700) t = vq.shift();
      else if (aq.length && aq[aq.length - 1].ts - aq[0].ts > 700) t = aq.shift();
      else break;
      this._emit(t);
    }
  }

  // FLV header + metadata + both sequence headers, timestamped at `ts`.
  init(ts) {
    const parts = [FLV_HEADER, serializeTag(SCRIPT, 0, onMetaData(this.meta))];
    if (this.avcC) parts.push(serializeTag(VIDEO, ts, videoConfigPayload(this.avcC)));
    if (this.asc) parts.push(serializeTag(AUDIO, ts, audioConfigPayload(this.asc)));
    return Buffer.concat(parts);
  }

  _emit(t) {
    this.lastTs = Math.max(this.lastTs, t.ts);
    if (t.type === VIDEO) this.videoFrames++;
    if (this.replayMs) {
      this.replay.push(t);
      if (t.type === VIDEO && t.key) this._trimReplay();
    }
    for (const sink of this.sinks) {
      if (!sink.ready) {
        if (!(t.type === VIDEO && t.key && this.ready)) continue;
        sink.ready = true;
        sink.base = t.ts;
        sink.onInit(this);
      }
      sink.onTag(t);
    }
  }

  _broadcastConfig(t) {
    for (const sink of this.sinks) if (sink.ready) sink.onTag(t);
    if (this.replayMs && this.replay.length) this.replay.push(t);
  }

  _trimReplay() {
    const r = this.replay;
    const cutoff = r[r.length - 1].ts - this.replayMs;
    let idx = -1;
    for (let i = 0; i < r.length && r[i].ts <= cutoff; i++) if (r[i].type === VIDEO && r[i].key) idx = i;
    if (idx > 0) r.splice(0, idx);
  }

  addSink(sink) {
    sink.ready = false;
    sink.base = 0;
    this.sinks.add(sink);
    return sink;
  }

  removeSink(sink) { this.sinks.delete(sink); }

  // A self-contained FLV of the replay buffer, rebased to start at 0. MP4 can
  // hold only one SPS/PPS set, so the clip starts after the last encoder
  // (re)configuration inside the buffer.
  snapshot(lastMs) {
    let tags = this.replay;
    let from = 0;
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i].config && tags[i].type === VIDEO) {
        from = i + 1;
        break;
      }
    }
    const start = tags.findIndex((t, i) => i >= from && t.type === VIDEO && t.key && !t.config);
    if (start < 0 || !this.ready) return null;
    tags = tags.slice(start).filter((t) => !t.config);
    if (lastMs) {
      const cutoff = tags[tags.length - 1].ts - lastMs;
      let idx = 0;
      for (let i = 0; i < tags.length && tags[i].ts <= cutoff; i++) if (tags[i].type === VIDEO && tags[i].key) idx = i;
      tags = tags.slice(idx);
    }
    const base = tags[0].ts;
    const parts = [this.init(0)];
    for (const t of tags) if (t.ts >= base) parts.push(serializeTag(t.type, t.ts - base, t.payload));
    return { flv: Buffer.concat(parts), durationMs: tags[tags.length - 1].ts - base };
  }
}

module.exports = { FlvMuxer, AdtsParser, serializeTag, videoConfigPayload, audioConfigPayload, AUDIO, VIDEO };
