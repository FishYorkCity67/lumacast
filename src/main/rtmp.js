'use strict';
// Native RTMP/RTMPS publisher. Replaces one ffmpeg relay process per
// destination: big chunks (4 KB) mean few socket writes, and the socket's own
// write queue gives real network backpressure for frame dropping.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const EventEmitter = require('events');
const { VIDEO, AUDIO, videoConfigPayload, audioConfigPayload } = require('./flv');

// ---- AMF0 --------------------------------------------------------------------------
function amfStr(s) {
  const b = Buffer.from(String(s), 'utf8');
  if (b.length > 0xffff) {
    const h = Buffer.alloc(5);
    h[0] = 0x0c;
    h.writeUInt32BE(b.length, 1);
    return Buffer.concat([h, b]);
  }
  const h = Buffer.alloc(3);
  h[0] = 0x02;
  h.writeUInt16BE(b.length, 1);
  return Buffer.concat([h, b]);
}

function amfKey(k) {
  const b = Buffer.from(k, 'utf8');
  const h = Buffer.alloc(2);
  h.writeUInt16BE(b.length);
  return Buffer.concat([h, b]);
}

function amfEncode(v) {
  if (v === null || v === undefined) return Buffer.from([0x05]);
  if (typeof v === 'number') {
    const b = Buffer.alloc(9);
    b[0] = 0;
    b.writeDoubleBE(v, 1);
    return b;
  }
  if (typeof v === 'boolean') return Buffer.from([1, v ? 1 : 0]);
  if (typeof v === 'string') return amfStr(v);
  const ecma = v.__ecma;
  const parts = [];
  if (ecma) {
    const h = Buffer.alloc(5);
    h[0] = 0x08;
    h.writeUInt32BE(Object.keys(v).filter((k) => k !== '__ecma').length, 1);
    parts.push(h);
  } else parts.push(Buffer.from([0x03]));
  for (const [k, val] of Object.entries(v)) {
    if (k === '__ecma' || val === undefined) continue;
    parts.push(amfKey(k), amfEncode(val));
  }
  parts.push(Buffer.from([0, 0, 9]));
  return Buffer.concat(parts);
}

const amfEncodeAll = (values) => Buffer.concat(values.map(amfEncode));

function amfDecodeAll(buf) {
  let off = 0;
  const readKey = () => {
    const len = buf.readUInt16BE(off);
    off += 2;
    const s = buf.toString('utf8', off, off + len);
    off += len;
    return s;
  };
  const readProps = (obj) => {
    for (;;) {
      if (off + 3 <= buf.length && buf[off] === 0 && buf[off + 1] === 0 && buf[off + 2] === 9) {
        off += 3;
        return obj;
      }
      const k = readKey();
      obj[k] = read();
    }
  };
  const read = () => {
    const type = buf[off++];
    switch (type) {
      case 0x00: { const v = buf.readDoubleBE(off); off += 8; return v; }
      case 0x01: return buf[off++] !== 0;
      case 0x02: return readKey();
      case 0x03: return readProps({});
      case 0x05: case 0x06: return null;
      case 0x08: off += 4; return readProps({});
      case 0x0a: {
        const n = buf.readUInt32BE(off);
        off += 4;
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(read());
        return arr;
      }
      case 0x0b: off += 10; return null;
      case 0x0c: {
        const len = buf.readUInt32BE(off);
        off += 4;
        const s = buf.toString('utf8', off, off + len);
        off += len;
        return s;
      }
      default: throw new Error(`AMF0 type ${type} unsupported`);
    }
  };
  const out = [];
  try {
    while (off < buf.length) out.push(read());
  } catch { /* keep what decoded */ }
  return out;
}

// rtmp[s]://host[:port]/app[?query] (+ stream key, or key as last path segment)
function parseTarget(server, key) {
  const m = /^(rtmps?):\/\/([^/:?#]+)(?::(\d+))?(?:\/(.*))?$/i.exec(String(server || '').trim());
  if (!m) throw new Error('Invalid server URL');
  const proto = m[1].toLowerCase();
  const host = m[2];
  const port = Number(m[3]) || (proto === 'rtmps' ? 443 : 1935);
  let app = (m[4] || '').replace(/\/+$/, '');
  let stream = String(key || '').trim();
  if (!stream) {
    const i = app.lastIndexOf('/');
    if (i < 0) throw new Error('Stream key missing');
    stream = app.slice(i + 1);
    app = app.slice(0, i);
  }
  return { proto, host, port, app, stream, tcUrl: `${proto}://${host}${m[3] ? `:${m[3]}` : ''}/${app}` };
}

const CS_PROTO = 2;
const CS_CMD = 3;
const CS_AUDIO = 4;
const CS_VIDEO = 6;
const CS_STREAM = 8;
const OUT_CHUNK = 4096;

// One RTMP session (connect -> publish -> media). Emits 'publishing', 'error', 'close'.
class RtmpSession extends EventEmitter {
  constructor(target, log) {
    super();
    this.t = target;
    this.log = log;
    this.inChunk = 128;
    this.ackWindow = 2500000;
    this.inBytes = 0;
    this.lastAck = 0;
    this.txid = 0;
    this.pending = new Map();
    this.streams = new Map();
    this.rbuf = Buffer.alloc(0);
    this.handshakeDone = false;
    this.bytesOut = 0;
  }

  open() {
    const { proto, host, port } = this.t;
    const onConnect = () => this._startHandshake();
    this.socket = proto === 'rtmps'
      ? tls.connect({ host, port, servername: host, ALPNProtocols: [] }, onConnect)
      : net.connect({ host, port }, onConnect);
    this.socket.setNoDelay(true);
    this.socket.setTimeout(15000, () => this._fail(new Error('Connection timed out')));
    this.socket.on('data', (d) => this._onData(d));
    this.socket.on('error', (err) => this._fail(err));
    this.socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
      this.pending.clear();
      this.emit('close');
    });
  }

  _fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.emit('error', err);
    if (this.socket) this.socket.destroy();
  }

  get queued() { return this.socket ? this.socket.writableLength : 0; }

  _write(buf) {
    if (!this.socket || this.socket.destroyed) return;
    this.bytesOut += buf.length;
    this.socket.write(buf);
  }

  // ---- handshake (simple, as used by OBS/librtmp for plain RTMP) -----------------------
  _startHandshake() {
    const c1 = crypto.randomBytes(1536);
    c1.writeUInt32BE(0, 0);
    c1.writeUInt32BE(0, 4);
    this._write(Buffer.concat([Buffer.from([3]), c1]));
    this.hsStage = 1;
  }

  _onData(d) {
    this.inBytes += d.length;
    if (this.handshakeDone && this.inBytes - this.lastAck >= this.ackWindow) {
      this.lastAck = this.inBytes;
      const p = Buffer.alloc(4);
      p.writeUInt32BE(this.inBytes >>> 0);
      this._send(CS_PROTO, 3, 0, 0, p);
    }
    this.rbuf = this.rbuf.length ? Buffer.concat([this.rbuf, d]) : d;
    if (!this.handshakeDone) {
      if (this.hsStage === 1 && this.rbuf.length >= 1 + 1536) {
        const s1 = this.rbuf.subarray(1, 1537);
        this._write(Buffer.from(s1)); // C2 = echo of S1
        this.hsStage = 2;
      }
      if (this.hsStage === 2 && this.rbuf.length >= 1 + 1536 * 2) {
        this.rbuf = this.rbuf.subarray(1 + 1536 * 2);
        this.handshakeDone = true;
        this.socket.setTimeout(0);
        this.emit('handshake');
      } else return;
    }
    this._parseChunks();
  }

  // ---- chunk stream parser ----------------------------------------------------------------
  _parseChunks() {
    let b = this.rbuf;
    let off = 0;
    for (;;) {
      if (b.length - off < 1) break;
      const fmt = b[off] >> 6;
      let csid = b[off] & 0x3f;
      let p = off + 1;
      if (csid === 0) {
        if (b.length - p < 1) break;
        csid = 64 + b[p];
        p += 1;
      } else if (csid === 1) {
        if (b.length - p < 2) break;
        csid = 64 + b[p] + b[p + 1] * 256;
        p += 2;
      }
      const mh = [11, 7, 3, 0][fmt];
      if (b.length - p < mh) break;
      const st = this.streams.get(csid) || { ts: 0, delta: 0, len: 0, type: 0, msid: 0, ext: false, parts: [], got: 0 };
      let tsField = st.ext ? 0xffffff : 0;
      let len = st.len;
      let type = st.type;
      let msid = st.msid;
      if (fmt <= 2) tsField = b.readUIntBE(p, 3);
      if (fmt <= 1) {
        len = b.readUIntBE(p + 3, 3);
        type = b[p + 6];
      }
      if (fmt === 0) msid = b.readUInt32LE(p + 7);
      p += mh;
      const ext = fmt <= 2 ? tsField === 0xffffff : st.ext;
      if (ext) {
        if (b.length - p < 4) break;
        tsField = b.readUInt32BE(p);
        p += 4;
      }
      const starting = st.got === 0;
      const size = Math.min(this.inChunk, len - st.got);
      if (b.length - p < size) break;
      // commit header state only once the whole chunk is available
      if (fmt === 0) { st.ts = tsField; st.delta = 0; } else if (fmt <= 2) { st.delta = tsField; if (starting) st.ts += tsField; } else if (starting) st.ts += st.delta;
      st.len = len;
      st.type = type;
      st.msid = msid;
      st.ext = ext;
      st.parts.push(b.subarray(p, p + size));
      st.got += size;
      p += size;
      off = p;
      this.streams.set(csid, st);
      if (st.got >= st.len) {
        const payload = Buffer.concat(st.parts);
        st.parts = [];
        st.got = 0;
        this._onMessage(st.type, st.msid, payload);
      }
    }
    this.rbuf = off ? Buffer.from(b.subarray(off)) : b;
  }

  _onMessage(type, msid, payload) {
    switch (type) {
      case 1: this.inChunk = payload.readUInt32BE(0) & 0x7fffffff; break;
      case 4: {
        const ev = payload.readUInt16BE(0);
        if (ev === 6) {
          const r = Buffer.alloc(6);
          r.writeUInt16BE(7, 0);
          payload.copy(r, 2, 2, 6);
          this._send(CS_PROTO, 4, 0, 0, r);
        }
        break;
      }
      case 5: this.ackWindow = payload.readUInt32BE(0); break;
      case 6: {
        const w = Buffer.alloc(4);
        w.writeUInt32BE(payload.readUInt32BE(0));
        this._send(CS_PROTO, 5, 0, 0, w);
        break;
      }
      case 20: this._onCommand(amfDecodeAll(payload)); break;
      case 17: this._onCommand(amfDecodeAll(payload.subarray(1))); break;
      default: break;
    }
  }

  _onCommand([name, txid, , info]) {
    if (name === '_result' || name === '_error') {
      const p = this.pending.get(txid);
      if (!p) return;
      this.pending.delete(txid);
      if (name === '_result') p.resolve(info);
      else p.reject(new Error((info && (info.description || info.code)) || 'Server rejected the request'));
      return;
    }
    if (name === 'onStatus') {
      const code = info && info.code;
      if (code === 'NetStream.Publish.Start') this.emit('publishing');
      else if (/Publish\.(BadName|Failed|Denied)|NetConnection\.Connect\.Rejected|Unauthorized/i.test(code || '')) {
        this._fail(new Error(`${code}${info.description ? `: ${info.description}` : ''}`));
      }
    } else if (name === 'close') {
      this._fail(new Error('Server closed the stream'));
    }
  }

  // ---- writing -------------------------------------------------------------------------------
  _send(csid, type, msid, ts, payload) {
    ts = Math.max(0, Math.round(ts)) >>> 0;
    const ext = ts >= 0xffffff;
    const parts = [];
    const head = Buffer.alloc(12 + (ext ? 4 : 0));
    head[0] = csid;
    head.writeUIntBE(ext ? 0xffffff : ts, 1, 3);
    head.writeUIntBE(payload.length, 4, 3);
    head[7] = type;
    head.writeUInt32LE(msid, 8);
    if (ext) head.writeUInt32BE(ts, 12);
    parts.push(head, payload.subarray(0, OUT_CHUNK));
    for (let off = OUT_CHUNK; off < payload.length; off += OUT_CHUNK) {
      const c = Buffer.alloc(ext ? 5 : 1);
      c[0] = 0xc0 | csid;
      if (ext) c.writeUInt32BE(ts, 1);
      parts.push(c, payload.subarray(off, off + OUT_CHUNK));
    }
    this._write(Buffer.concat(parts));
  }

  _call(name, args, csid = CS_CMD, msid = 0, expectReply = true) {
    const id = ++this.txid;
    this._send(csid, 20, msid, 0, amfEncodeAll([name, id, ...args]));
    if (!expectReply) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`No reply to ${name}`));
        }
      }, 15000);
    });
  }

  async publish() {
    await new Promise((resolve, reject) => {
      this.once('handshake', resolve);
      this.once('error', reject);
      this.open();
    });
    const cs = Buffer.alloc(4);
    cs.writeUInt32BE(OUT_CHUNK);
    this._send(CS_PROTO, 1, 0, 0, cs);
    const { app, tcUrl, stream } = this.t;
    const info = await this._call('connect', [{ app, type: 'nonprivate', flashVer: 'FMLE/3.0 (compatible; Lumacast)', swfUrl: tcUrl, tcUrl }]);
    if (info && info.code && info.code !== 'NetConnection.Connect.Success') throw new Error(info.description || info.code);
    this._call('releaseStream', [null, stream], CS_CMD, 0, false);
    this._call('FCPublish', [null, stream], CS_CMD, 0, false);
    const sid = await this._call('createStream', [null]);
    this.streamId = typeof sid === 'number' ? sid : 1;
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 6000); // some ingests never confirm
      this.once('publishing', () => { clearTimeout(timer); resolve(); });
      this.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this._call('publish', [null, stream, 'live'], CS_STREAM, this.streamId, false);
    await started;
  }

  sendMeta(meta) {
    this._send(CS_AUDIO, 18, this.streamId, 0, amfEncodeAll(['@setDataFrame', 'onMetaData', { ...meta, __ecma: true }]));
  }

  sendMedia(type, ts, payload) {
    this._send(type === VIDEO ? CS_VIDEO : CS_AUDIO, type, this.streamId, ts, payload);
  }

  close() {
    if (!this.socket || this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        this._call('FCUnpublish', [null, this.t.stream], CS_CMD, 0, false);
        if (this.streamId) this._call('deleteStream', [null, this.streamId], CS_CMD, 0, false);
      } catch { /* socket gone */ }
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.socket.destroy(); resolve(); }, 3000);
      this.socket.once('close', done);
      this.socket.end();
    });
  }
}

// Output with the same interface as engine.Output (status/congestion events,
// reconnect with backoff, frame dropping), but speaking RTMP itself.
class RtmpOutput extends EventEmitter {
  constructor(opts, engine, log) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.kind = 'rtmp';
    this.canvas = opts.canvas || 'h';
    this.server = opts.server;
    this.key = opts.key || '';
    this.engine = engine;
    this.log = log;
    this.status = 'idle';
    this.error = '';
    this.reconnects = 0;
    this.attempt = 0;
    this.dropped = 0;
    this.bytesOut = 0;
    this._statBytes = 0;
    this._statAt = Date.now();
    this.session = null;
  }

  _clean(msg) {
    let t = String(msg || '');
    if (this.key) t = t.split(this.key).join('••••');
    return t;
  }

  _setStatus(status, error) {
    if (this.status === status && (error === undefined || error === this.error)) return;
    this.status = status;
    if (error !== undefined) this.error = this._clean(error);
    this.emit('status', this.status, this.error);
  }

  start() {
    this.wanted = true;
    this.startedAt = Date.now();
    this._connect();
  }

  async _connect() {
    const muxer = this.engine.muxers.get(this.canvas);
    if (!muxer) {
      this.wanted = false;
      this._setStatus('error', 'Canvas is not being encoded');
      return;
    }
    this.muxer = muxer;
    const kbps = (muxer.meta.videodatarate || 6000) + (muxer.meta.audiodatarate || 160);
    this.highWater = Math.round(((kbps * 1000) / 8) * 2.5);
    this.lowWater = Math.round(this.highWater / 4);
    this.dropping = false;
    let target;
    try {
      target = parseTarget(this.server, this.key);
    } catch (err) {
      this.wanted = false;
      this._setStatus('error', err.message);
      return;
    }
    const session = new RtmpSession(target, this.log);
    this.session = session;
    this._setStatus(this.reconnects ? 'reconnecting' : 'connecting', '');
    session.on('error', (err) => {
      this.error = this._clean(err.message || err);
      this.log(this.name, `rtmp error: ${this.error}`);
    });
    session.on('close', () => this._onClose(session));
    try {
      await session.publish();
    } catch (err) {
      if (this.session === session) {
        this.error = this._clean(err.message || err);
        session.socket && session.socket.destroy();
      }
      return;
    }
    if (this.session !== session || !this.wanted) {
      session.close();
      return;
    }
    this.attempt = 0;
    this._setStatus('live', '');
    this.sink = muxer.addSink({
      onInit: (m) => {
        session.sendMeta(m.meta);
        if (m.avcC) session.sendMedia(VIDEO, 0, videoConfigPayload(m.avcC));
        if (m.asc) session.sendMedia(AUDIO, 0, audioConfigPayload(m.asc));
      },
      onTag: (t) => this._onTag(t),
    });
  }

  _onTag(t) {
    const s = this.session;
    if (!s || s.closed) return;
    if (!t.config) {
      const queued = s.queued;
      if (this.dropping) {
        if (t.type === VIDEO && t.key && queued < this.lowWater) this.dropping = false;
        else {
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
    const before = s.bytesOut;
    s.sendMedia(t.type, t.ts - this.sink.base, t.payload);
    this.bytesOut += s.bytesOut - before;
  }

  _onClose(session) {
    if (session !== this.session) return;
    if (this.sink && this.muxer) this.muxer.removeSink(this.sink);
    this.sink = null;
    this.session = null;
    if (!this.wanted) {
      this._setStatus('offline');
      this.emit('closed');
      return;
    }
    this.reconnects++;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.attempt++, 4));
    this._setStatus('reconnecting', this.error || 'Connection lost');
    this.retryTimer = setTimeout(() => {
      if (this.wanted && this.engine.running) this._connect();
    }, delay);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    const s = this.session;
    if (this.sink && this.muxer) this.muxer.removeSink(this.sink);
    this.sink = null;
    if (!s) {
      this._setStatus('offline');
      this.emit('closed');
      return;
    }
    s.close();
  }

  closed() {
    if (!this.session && !this.wanted) return Promise.resolve();
    return new Promise((resolve) => this.once('closed', resolve));
  }

  stats() {
    const now = Date.now();
    const dt = Math.max(0.25, (now - this._statAt) / 1000);
    const kbps = ((this.bytesOut - this._statBytes) * 8) / 1000 / dt;
    this._statBytes = this.bytesOut;
    this._statAt = now;
    const queued = this.session ? this.session.queued : 0;
    const rate = this.muxer ? (this.muxer.meta.videodatarate || 6000) + (this.muxer.meta.audiodatarate || 160) : 6000;
    return {
      id: this.id, name: this.name, kind: 'rtmp', canvas: this.canvas, status: this.status, error: this.error,
      kbps: Math.round(kbps), dropped: this.dropped, reconnects: this.reconnects,
      queueMs: Math.round((queued * 8) / rate), bytes: this.bytesOut, uptime: this.startedAt ? now - this.startedAt : 0,
    };
  }
}

module.exports = { RtmpOutput, parseTarget, amfEncodeAll, amfDecodeAll };
