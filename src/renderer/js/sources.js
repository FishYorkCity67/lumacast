// Runtime objects for every source type. Each draws itself into a w*h box in
// canvas pixels; the compositor handles placement, rotation and opacity.
import { Emitter, clamp, ease, fileUrl, fmtDuration, deepClone } from './util.js';
import { state, rt, PLATFORMS } from './state.js';
import { drawAvatar, AVATAR_COLORS } from './avatars.js';

const ZERO = { l: 0, t: 0, r: 0, b: 0 };
const UI_FONT = '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
const DISPLAY_FONT = '"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif';

export function withAlpha(color, a) {
  const c = String(color || '#000000');
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return c;
}

function drawCropped(ctx, img, nw, nh, w, h, crop) {
  const c = crop || ZERO;
  const sx = clamp(c.l || 0, 0, nw - 1);
  const sy = clamp(c.t || 0, 0, nh - 1);
  const sw = clamp(nw - (c.l || 0) - (c.r || 0), 1, nw - sx);
  const sh = clamp(nh - (c.t || 0) - (c.b || 0), 1, nh - sy);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)));
}

// ---- images (static + animated via ImageDecoder) -------------------------------
const imageCache = new Map();
export function loadImage(path) {
  if (!path) return Promise.resolve(null);
  if (imageCache.has(path)) return imageCache.get(path);
  const p = (async () => {
    const ext = path.split('.').pop().toLowerCase();
    if (['gif', 'webp', 'png', 'apng'].includes(ext) && 'ImageDecoder' in window) {
      try {
        const bytes = await window.lc.invoke('file:read', path);
        const type = { gif: 'image/gif', webp: 'image/webp', png: 'image/png', apng: 'image/png' }[ext];
        const dec = new ImageDecoder({ data: bytes, type });
        await dec.tracks.ready;
        await dec.completed;
        const track = dec.tracks.selectedTrack;
        if (track && track.frameCount > 1) {
          const frames = [];
          const times = [];
          let total = 0;
          const n = Math.min(track.frameCount, 400);
          for (let i = 0; i < n; i++) {
            const { image } = await dec.decode({ frameIndex: i });
            frames.push(await createImageBitmap(image));
            total += Math.max(20, (image.duration || 100000) / 1000);
            times.push(total);
            image.close();
          }
          dec.close();
          return { kind: 'anim', frames, times, total, w: frames[0].width, h: frames[0].height };
        }
        dec.close();
      } catch (err) {
        console.warn('animated decode failed, using <img>', err);
      }
    }
    const img = new Image();
    img.src = fileUrl(path);
    await img.decode();
    return { kind: 'static', img, w: img.naturalWidth, h: img.naturalHeight };
  })();
  imageCache.set(path, p);
  p.catch(() => imageCache.delete(path));
  return p;
}

function imageFrame(asset, t) {
  if (asset.kind === 'static') return asset.img;
  const m = ((t % asset.total) + asset.total) % asset.total;
  let i = 0;
  while (i < asset.times.length - 1 && asset.times[i] < m) i++;
  return asset.frames[i];
}

// ---- text rendering shared by text + timer ---------------------------------------
const scratch = new OffscreenCanvas(8, 8).getContext('2d');

function fontString(s, size) {
  return `${s.italic ? 'italic ' : ''}${s.weight || 700} ${size}px ${s.font ? `"${s.font}",` : ''}${DISPLAY_FONT}`;
}

export function renderTextCanvas(s, text) {
  const size = s.size || 64;
  const lines = String(text ?? '').split('\n');
  const font = fontString(s, size);
  scratch.font = font;
  const widths = lines.map((l) => scratch.measureText(l || ' ').width);
  const lh = size * (s.lineHeight || 1.18);
  const outline = s.outline || 0;
  const bgOn = (s.bgOpacity || 0) > 0;
  const pad = bgOn ? size * 0.42 : size * 0.1 + outline;
  const sp = s.shadow ? size * 0.22 : 0;
  const W = Math.max(2, Math.ceil(Math.max(...widths) + (pad + sp) * 2));
  const H = Math.max(2, Math.ceil(lines.length * lh + (pad + sp) * 2));
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  if (bgOn) {
    ctx.fillStyle = withAlpha(s.bg || '#000000', s.bgOpacity);
    rr(ctx, sp, sp, W - sp * 2, H - sp * 2, size * 0.32);
    ctx.fill();
  }
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const top = sp + pad;
  let fill = s.color || '#ffffff';
  if (s.gradient) {
    const g = ctx.createLinearGradient(0, top, 0, top + lines.length * lh);
    g.addColorStop(0, s.color || '#ffffff');
    g.addColorStop(1, s.color2 || '#9fb4ff');
    fill = g;
  }
  const xs = [];
  lines.forEach((line, i) => {
    const y = top + lh * (i + 0.5);
    const align = s.align || 'center';
    const x = align === 'left' ? sp + pad : align === 'right' ? W - sp - pad - widths[i] : (W - widths[i]) / 2;
    xs.push(x);
    if (s.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = size * 0.18;
      ctx.shadowOffsetY = size * 0.06;
      ctx.fillStyle = s.color || '#ffffff';
      ctx.fillText(line, x, y);
      ctx.restore();
    }
    if (outline > 0) {
      ctx.lineWidth = outline * 2;
      ctx.strokeStyle = s.outlineColor || '#000000';
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, x, y);
  });
  return { canvas: c, w: W, h: H, lines, widths, xs, lh, top, font, fill, size };
}

// ---- base classes ------------------------------------------------------------------
class BaseSource {
  constructor(def, mgr) {
    this.def = def;
    this.mgr = mgr;
    this.id = def.id;
    this.type = def.type;
    this.ready = false;
    this.error = '';
    this.t0 = performance.now();
  }

  get s() { return this.def.settings || {}; }
  async start() { this.ready = true; }
  stop() {}
  async update(def) { this.def = def; }
  natural() { return null; }
  draw() {}
  onShow() {}
  get shieldable() { return false; }
}

class VideoSource extends BaseSource {
  async start() {
    this.stopped = false;
    try {
      await this.open();
    } catch (err) {
      this.error = String(err.message || err);
      this.retry(3000);
    }
  }

  setStream(stream) {
    this.closeStream();
    this.stream = stream;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = stream;
    v.play().catch(() => {});
    v.addEventListener('loadeddata', () => this.mgr.emit('source-ready', this.id));
    this.video = v;
    this.ready = true;
    this.error = '';
    const tr = stream.getVideoTracks()[0];
    if (tr) tr.addEventListener('ended', () => this.onEnded());
  }

  closeStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.ready = false;
  }

  onEnded() {
    this.ready = false;
    this.error = 'Capture ended';
    this.retry(4000);
  }

  retry(ms) {
    clearTimeout(this.retryTimer);
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.open().catch((err) => {
        this.error = String(err.message || err);
        // windows come back quickly (Alt+Tab into a game), so keep polling fast
        this.retry(this.type === 'window' ? 2500 : Math.min(ms * 1.5, 20000));
      });
    }, ms);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.closeStream();
  }

  natural() {
    const v = this.video;
    return v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
  }

  drawFrame(ctx, w, h, o) {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return false;
    drawCropped(ctx, v, v.videoWidth, v.videoHeight, w, h, o.crop);
    return true;
  }
}

// ---- display / window capture -------------------------------------------------------
class CaptureSource extends VideoSource {
  get shieldable() {
    return this.type === 'display' || (this.type === 'window' && state.settings.privacy.windows);
  }

  async open() {
    const s = this.s;
    const kind = this.type === 'window' ? 'window' : 'screen';
    if (kind === 'window' && !s.sourceId && !s.name) {
      this.error = 'Pick a window in the properties';
      return;
    }
    const list = await window.lc.invoke('capture:sources', [kind], false);
    const live = list.filter((x) => !x.minimized);
    let found = live.find((x) => x.id === s.sourceId);
    if (!found && kind === 'window') {
      // games change their title constantly, so the process is the best match
      found = live.find((x) => s.process && x.process === s.process)
        || live.find((x) => s.name && x.name === s.name)
        || live.find((x) => s.app && x.name.endsWith(s.app));
      if (!found && list.some((x) => x.minimized && ((s.process && x.process === s.process) || x.name === s.name))) {
        this.waiting = true;
        throw new Error('Window is minimized – switch to it to start capturing');
      }
    }
    if (!found && kind === 'screen') found = list.find((x) => s.displayId && x.displayId === s.displayId) || list[0];
    if (!found) throw new Error(kind === 'window' ? 'Window not found' : 'No screen found');
    this.waiting = false;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: found.id, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } },
    });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.capturedName = found.name;
    this.setStream(stream);
  }

  async update(def, prev) {
    this.def = def;
    if (prev.sourceId !== def.settings.sourceId || prev.name !== def.settings.name || prev.process !== def.settings.process) {
      this.stopped = false;
      await this.open().catch((err) => {
        this.error = String(err.message || err);
        this.retry(3000);
      });
    }
  }

  draw(ctx, w, h, o) {
    if (!this.drawFrame(ctx, w, h, o)) return;
    if (o.privacy > 0.001) this.drawShield(ctx, w, h, o);
  }

  drawShield(ctx, w, h, o) {
    const v = this.video;
    const bw = 40;
    const bh = Math.max(6, Math.round((bw * h) / Math.max(1, w)));
    if (!this.blur || this.blur.width !== bw || this.blur.height !== bh) {
      this.blur = new OffscreenCanvas(bw, bh);
      this.blurCtx = this.blur.getContext('2d');
      this.blurCtx.imageSmoothingQuality = 'high';
    }
    drawCropped(this.blurCtx, v, v.videoWidth, v.videoHeight, bw, bh, o.crop);
    ctx.save();
    ctx.globalAlpha *= o.privacy;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.blur, 0, 0, w, h);
    ctx.fillStyle = 'rgba(6,7,16,.45)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

// ---- camera ---------------------------------------------------------------------------
const RES = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160] };

class CameraSource extends VideoSource {
  async open() {
    const s = this.s;
    const [w, h] = RES[s.resolution || '1080p'] || RES['1080p'];
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: s.deviceId ? { exact: s.deviceId } : undefined,
        width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: s.fps || 30 },
      },
    });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setStream(stream);
  }

  async update(def, prev) {
    this.def = def;
    const s = def.settings;
    if (prev.deviceId !== s.deviceId || prev.resolution !== s.resolution || prev.fps !== s.fps) {
      this.stopped = false;
      await this.open().catch((err) => {
        this.error = String(err.message || err);
        this.retry(3000);
      });
    }
  }

  borderPaint(ctx, w, h, now) {
    const s = this.s;
    if (s.borderStyle === 'rainbow' || s.borderStyle === 'gradient') {
      const g = ctx.createConicGradient(((now / 1000) * (s.borderStyle === 'rainbow' ? 1.4 : 0.7)) % (Math.PI * 2), w / 2, h / 2);
      if (s.borderStyle === 'rainbow') {
        for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60} 95% 62%)`);
      } else {
        g.addColorStop(0, s.borderColor || '#7c5cff');
        g.addColorStop(0.5, s.borderColor2 || '#22d3ee');
        g.addColorStop(1, s.borderColor || '#7c5cff');
      }
      return g;
    }
    return s.borderColor || '#ffffff';
  }

  draw(ctx, w, h, o) {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const s = this.s;
    const r = ((s.radius || 0) / 100) * (Math.min(w, h) / 2);
    if (s.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.5)';
      ctx.shadowBlur = Math.min(w, h) * 0.07;
      ctx.shadowOffsetY = Math.min(w, h) * 0.02;
      ctx.fillStyle = '#000';
      rr(ctx, 0, 0, w, h, r);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    if (r > 0) {
      rr(ctx, 0, 0, w, h, r);
      ctx.clip();
    }
    if (s.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    drawCropped(ctx, v, v.videoWidth, v.videoHeight, w, h, o.crop);
    ctx.restore();
    const bw = s.border || 0;
    if (bw > 0) {
      ctx.save();
      ctx.lineWidth = bw;
      ctx.strokeStyle = this.borderPaint(ctx, w, h, o.now);
      rr(ctx, bw / 2, bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2));
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ---- image ------------------------------------------------------------------------------
class ImageSource extends BaseSource {
  async start() { await this.load(); }

  async load() {
    this.asset = null;
    this.ready = false;
    if (!this.s.file) return;
    try {
      this.asset = await loadImage(this.s.file);
      this.ready = !!this.asset;
      this.t0 = performance.now();
      this.mgr.emit('source-ready', this.id);
    } catch (err) {
      this.error = String(err.message || err);
    }
  }

  async update(def, prev) {
    this.def = def;
    if (prev.file !== def.settings.file) await this.load();
  }

  natural() { return this.asset ? { w: this.asset.w, h: this.asset.h } : null; }

  draw(ctx, w, h, o) {
    if (!this.asset) return;
    drawCropped(ctx, imageFrame(this.asset, o.now - this.t0), this.asset.w, this.asset.h, w, h, o.crop);
  }
}

// ---- media file -------------------------------------------------------------------------
class MediaFileSource extends BaseSource {
  async start() { this.open(); }

  audioCfg() {
    const s = this.s;
    return { name: this.def.name, volume: s.volume ?? 1, muted: !!s.muted, monitor: !!s.monitor };
  }

  open() {
    this.close();
    const s = this.s;
    if (!s.file) return;
    const v = document.createElement('video');
    v.src = fileUrl(s.file);
    v.loop = s.loop !== false;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', () => {
      this.ready = true;
      this.mgr.emit('source-ready', this.id);
    });
    v.addEventListener('error', () => { this.error = 'Cannot play this file'; });
    this.video = v;
    this.mgr.audio.attachElement(this.id, this.def.name, v, this.audioCfg());
    v.play().catch(() => {});
  }

  close() {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    this.mgr.audio.remove(this.id);
    this.ready = false;
  }

  async update(def, prev) {
    this.def = def;
    if (prev.file !== def.settings.file || prev.loop !== def.settings.loop) this.open();
    else this.mgr.audio.updateChannel(this.id, this.audioCfg());
  }

  onShow() {
    if (this.s.restartOnShow && this.video) {
      this.video.currentTime = 0;
      this.video.play().catch(() => {});
    }
  }

  stop() { this.close(); }

  natural() {
    const v = this.video;
    return v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
  }

  draw(ctx, w, h, o) {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    drawCropped(ctx, v, v.videoWidth, v.videoHeight, w, h, o.crop);
  }
}

// ---- text -------------------------------------------------------------------------------
class TextSource extends BaseSource {
  async start() {
    this.render();
    this.ready = true;
    this.mgr.emit('source-ready', this.id);
  }

  text() { return this.s.text ?? ''; }

  render(text = this.text()) {
    this.r = renderTextCanvas(this.s, text);
    this.typedN = -1;
    this.charW = null;
  }

  async update(def) {
    this.def = def;
    this.render();
  }

  natural() { return this.r ? { w: this.r.w, h: this.r.h } : null; }

  draw(ctx, w, h, o) {
    const r = this.r;
    if (!r) return;
    const s = this.s;
    const t = (o.now - this.t0) / 1000;
    const sc = Math.min(w / r.w, h / r.h);
    const dw = r.w * sc;
    const dh = r.h * sc;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    const anim = this.type === 'timer' && s.anim !== 'pulse' && s.anim !== 'glow' ? 'none' : s.anim;
    switch (anim) {
      case 'pulse': {
        const k = 1 + 0.035 * Math.sin(t * 2.6);
        ctx.translate(w / 2, h / 2);
        ctx.scale(k, k);
        ctx.translate(-w / 2, -h / 2);
        ctx.drawImage(r.canvas, dx, dy, dw, dh);
        break;
      }
      case 'glow': {
        ctx.shadowColor = s.color2 || s.color || '#ffffff';
        ctx.shadowBlur = (14 + 12 * Math.sin(t * 3)) * sc;
        ctx.drawImage(r.canvas, dx, dy, dw, dh);
        break;
      }
      case 'marquee': {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();
        const k = h / r.h;
        const cw = r.w * k;
        const gap = h * 1.5;
        const off = (t * (s.speed || 1) * 160) % (cw + gap);
        for (let x = w - off; x > -cw - gap; x -= cw + gap) ctx.drawImage(r.canvas, x, 0, cw, h);
        ctx.restore();
        break;
      }
      case 'typewriter': {
        const full = this.text();
        const cps = 14 * (s.speed || 1);
        const cycle = full.length / cps + 3;
        const n = Math.min(full.length, Math.floor((t % cycle) * cps));
        if (n !== this.typedN) {
          this.typedN = n;
          this.tr = renderTextCanvas({ ...s, align: 'left' }, full.slice(0, n) || ' ');
        }
        ctx.drawImage(this.tr.canvas, dx, dy, this.tr.w * sc, this.tr.h * sc);
        if (Math.floor(t * 2.2) % 2 === 0 && n < full.length) {
          ctx.fillStyle = s.color || '#fff';
          ctx.fillRect(dx + (this.tr.w - r.size * 0.12) * sc, dy + (r.top + r.size * 0.05) * sc, r.size * 0.06 * sc, r.lh * 0.8 * sc);
        }
        break;
      }
      case 'wave': {
        if (!this.charW) {
          scratch.font = r.font;
          this.charW = r.lines.map((l) => [...l].map((ch) => scratch.measureText(ch).width));
        }
        ctx.translate(dx, dy);
        ctx.scale(sc, sc);
        ctx.font = r.font;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        let gi = 0;
        r.lines.forEach((line, li) => {
          let x = r.xs[li];
          const y0 = r.top + r.lh * (li + 0.5);
          [...line].forEach((ch, ci) => {
            const y = y0 + Math.sin(t * 4 - gi * 0.42) * r.size * 0.08;
            if (s.outline > 0) {
              ctx.lineWidth = s.outline * 2;
              ctx.strokeStyle = s.outlineColor || '#000';
              ctx.strokeText(ch, x, y);
            }
            ctx.fillStyle = r.fill;
            ctx.fillText(ch, x, y);
            x += this.charW[li][ci];
            gi++;
          });
        });
        break;
      }
      default:
        ctx.drawImage(r.canvas, dx, dy, dw, dh);
    }
  }
}

// ---- timer (countdown / stopwatch / clock) ---------------------------------------
class TimerSource extends TextSource {
  async start() {
    this.startAt = performance.now();
    this.ended = false;
    await super.start();
  }

  onShow() {
    if (this.s.restartOnShow !== false && (this.s.mode || 'countdown') === 'countdown') this.restart();
  }

  restart() {
    this.startAt = performance.now();
    this.ended = false;
  }

  async update(def, prev) {
    this.def = def;
    if (prev.minutes !== def.settings.minutes || prev.mode !== def.settings.mode) this.restart();
    this.lastText = null;
    this.render(this.text());
  }

  text(now = performance.now()) {
    const s = this.s;
    const mode = s.mode || 'countdown';
    if (mode === 'clock') {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: s.seconds === false ? undefined : '2-digit' });
    }
    if (mode === 'stopwatch') {
      const ms = rt.live ? Date.now() - rt.liveStart : now - this.startAt;
      return `${s.prefix || ''}${fmtDuration(ms)}`;
    }
    const remain = (Number(s.minutes) || 5) * 60000 - (now - (this.startAt || now));
    if (remain <= 0) {
      if (!this.ended) {
        this.ended = true;
        this.mgr.emit('timer-ended', this.id, s.endSceneId);
      }
      return s.endText || '00:00';
    }
    return `${s.prefix || ''}${fmtDuration(remain + 999)}`;
  }

  draw(ctx, w, h, o) {
    const txt = this.text(o.now);
    if (txt !== this.lastText) {
      this.lastText = txt;
      this.r = renderTextCanvas(this.s, txt);
    }
    super.draw(ctx, w, h, o);
  }
}

// ---- solid / gradient / aurora backgrounds -----------------------------------------
class ColorSource extends BaseSource {
  draw(ctx, w, h, o) {
    const s = this.s;
    const mode = s.mode || 'solid';
    if (mode === 'solid') {
      ctx.fillStyle = s.color || '#101018';
      ctx.fillRect(0, 0, w, h);
      return;
    }
    if (mode === 'gradient') {
      const a = ((s.angle ?? 135) * Math.PI) / 180;
      const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
      const dx = (Math.cos(a) * len) / 2;
      const dy = (Math.sin(a) * len) / 2;
      const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
      g.addColorStop(0, s.color || '#7c5cff');
      g.addColorStop(1, s.color2 || '#22d3ee');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const t = (o.now - this.t0) / 1000;
    ctx.fillStyle = s.base || '#06070f';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const R = Math.max(w, h) * 0.62;
    const blobs = [
      [s.color || '#7c5cff', 0.28, 0.32, 0.061, 0.043],
      [s.color2 || '#22d3ee', 0.72, 0.62, 0.052, 0.067],
      [s.color3 || '#ff4fa3', 0.45, 0.85, 0.039, 0.057],
    ];
    for (const [col, bx, by, fx, fy] of blobs) {
      const x = w * (bx + 0.2 * Math.sin(t * fx * Math.PI * 2));
      const y = h * (by + 0.16 * Math.cos(t * fy * Math.PI * 2));
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, withAlpha(col, 0.5));
      g.addColorStop(1, withAlpha(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }
}

// ---- chat overlay ---------------------------------------------------------------------
class ChatOverlaySource extends BaseSource {
  async start() {
    this.ready = true;
    this.layouts = new Map();
    this.ypos = new Map();
    this.frame = 0;
  }

  layoutMsg(m, maxW, fs) {
    const key = `${m.id}|${Math.round(maxW)}|${fs}`;
    const hit = this.layouts.get(key);
    if (hit) return hit;
    const nameFont = `700 ${fs}px ${UI_FONT}`;
    const textFont = `500 ${fs}px ${UI_FONT}`;
    const es = fs * 1.35;
    const lineH = fs * 1.38;
    const tokens = [];
    if (!m.system) tokens.push({ kind: 'name', text: `${m.user}${m.action ? ' ' : '  '}`, color: m.color });
    for (const p of m.parts || [{ type: 'text', text: m.text }]) {
      if (p.type === 'emote') tokens.push({ kind: 'emote', url: p.url, name: p.name });
      else for (const word of String(p.text).split(/(\s+)/)) if (word) tokens.push({ kind: 'text', text: word });
    }
    const lines = [[]];
    let x = 0;
    let maxX = 0;
    for (const tok of tokens) {
      let w;
      if (tok.kind === 'emote') w = es + fs * 0.12;
      else {
        scratch.font = tok.kind === 'name' ? nameFont : textFont;
        w = scratch.measureText(tok.text).width;
      }
      const ws = tok.kind === 'text' && /^\s+$/.test(tok.text);
      if (x + w > maxW && x > 0 && !ws) {
        lines.push([]);
        x = 0;
      }
      if (ws && x === 0) continue;
      lines[lines.length - 1].push({ ...tok, x, w });
      x += w;
      maxX = Math.max(maxX, x);
    }
    const out = { lines, lineH, width: maxX, height: lines.length * lineH, nameFont, textFont, es };
    if (this.layouts.size > 600) this.layouts.clear();
    this.layouts.set(key, out);
    return out;
  }

  draw(ctx, w, h, o) {
    const s = this.s;
    const fs = s.fontSize || 26;
    const pad = fs * 0.6;
    const gap = fs * 0.32;
    const bar = s.showPlatform !== false ? fs * 0.22 : 0;
    const msgs = this.mgr.chat.messages;
    const maxW = Math.max(40, w - pad * 2 - bar);
    const now = o.now;
    let y = h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-fs * 2, 0, w + fs * 4, h);
    ctx.clip();
    for (let i = msgs.length - 1, shown = 0; i >= 0 && y > 0 && shown < (s.max || 12); i--) {
      const m = msgs[i];
      if (m.deleted || (s.hideHistory !== false && m.history)) continue;
      const age = now - m.at;
      let alpha = 1;
      if (s.fade > 0) {
        const fadeAt = s.fade * 1000;
        if (age > fadeAt + 600) continue;
        if (age > fadeAt) alpha = 1 - (age - fadeAt) / 600;
      }
      shown++;
      const L = this.layoutMsg(m, maxW, fs);
      const bh = L.height + pad * 1.1;
      const bw = Math.min(w, L.width + pad * 2 + bar);
      const target = y - bh;
      y = target - gap;
      const key = `${o.canvas}|${m.id}`;
      const prev = this.ypos.get(key);
      const cy = prev === undefined ? target : prev + (target - prev) * 0.2;
      this.ypos.set(key, cy);
      const enter = ease.outCubic(clamp(age / 420, 0, 1));
      const dx = (1 - enter) * -fs * 1.5;
      ctx.globalAlpha = alpha * enter;
      const pc = (PLATFORMS[m.platform] || PLATFORMS.custom).color;
      if (m.paid) {
        const g = ctx.createLinearGradient(dx, cy, dx + bw, cy + bh);
        g.addColorStop(0, 'rgba(255,183,3,.92)');
        g.addColorStop(1, 'rgba(255,94,58,.92)');
        ctx.fillStyle = g;
      } else ctx.fillStyle = `rgba(10,12,22,${s.bg ?? 0.55})`;
      rr(ctx, dx, cy, bw, bh, fs * 0.5);
      ctx.fill();
      if (m.system) {
        ctx.strokeStyle = withAlpha(pc, 0.9);
        ctx.lineWidth = Math.max(1.5, fs * 0.08);
        ctx.stroke();
      }
      if (bar) {
        ctx.fillStyle = pc;
        rr(ctx, dx, cy, bar, bh, bar / 2);
        ctx.fill();
      }
      ctx.textBaseline = 'middle';
      L.lines.forEach((line, li) => {
        const ly = cy + pad * 0.55 + L.lineH * (li + 0.5);
        for (const tok of line) {
          const tx = dx + bar + pad + tok.x;
          if (tok.kind === 'emote') {
            const img = this.mgr.image(tok.url);
            if (img.complete && img.naturalWidth) ctx.drawImage(img, tx, ly - L.es / 2, L.es, L.es);
          } else {
            ctx.font = tok.kind === 'name' ? L.nameFont : L.textFont;
            ctx.fillStyle = tok.kind === 'name' ? (tok.color || '#a5b4fc') : m.paid ? '#1b1205' : m.system ? '#e9e6ff' : '#f2f3fb';
            ctx.fillText(tok.text, tx, ly);
          }
        }
      });
    }
    ctx.restore();
    if (++this.frame % 300 === 0 && this.ypos.size > 200) {
      const keep = new Set(msgs.slice(-60).map((m) => m.id));
      for (const k of this.ypos.keys()) if (!keep.has(k.split('|')[1])) this.ypos.delete(k);
    }
  }
}

// ---- alerts ----------------------------------------------------------------------------
const ALERT_STYLE = {
  sub: { emoji: '💜', color: '#9146ff', color2: '#c4b5fd' },
  gift: { emoji: '🎁', color: '#f472b6', color2: '#fbcfe8' },
  raid: { emoji: '🚀', color: '#22d3ee', color2: '#a5f3fc' },
  cheer: { emoji: '💎', color: '#38bdf8', color2: '#bae6fd' },
  superchat: { emoji: '💰', color: '#fbbf24', color2: '#fde68a' },
  member: { emoji: '🎉', color: '#34d399', color2: '#a7f3d0' },
  follow: { emoji: '❤️', color: '#fb7185', color2: '#fecdd3' },
  test: { emoji: '✨', color: '#7c5cff', color2: '#22d3ee' },
};

class AlertsSource extends BaseSource {
  async start() {
    this.ready = true;
    this.queue = [];
    this.cur = null;
    this.off = this.mgr.on('alert', (a) => this.queue.push(a));
  }

  stop() { if (this.off) this.off(); }

  draw(ctx, w, h, o) {
    const now = o.now;
    const D = (this.s.duration || 6) * 1000;
    if (!this.cur && this.queue.length) {
      this.cur = { ...this.queue.shift(), start: now, particles: null };
      if (this.s.sound !== false) this.mgr.audio.chime(this.cur.type);
    }
    const a = this.cur;
    if (!a) return;
    const t = now - a.start;
    if (t > D) {
      this.cur = null;
      return;
    }
    const st = ALERT_STYLE[a.type] || ALERT_STYLE.test;
    const enter = ease.outBack(clamp(t / 650, 0, 1));
    const exit = clamp((t - (D - 450)) / 450, 0, 1);
    const alpha = clamp(t / 250, 0, 1) * (1 - exit);
    const scale = 0.6 + 0.4 * enter;
    const float = Math.sin(t / 600) * h * 0.012;
    const cardW = Math.min(w, h * 3.2);
    const cardH = Math.min(h, cardW / 3.2);
    const cx = w / 2;
    const cy = h / 2 + float - exit * h * 0.08;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    const g = ctx.createLinearGradient(-cardW / 2, -cardH / 2, cardW / 2, cardH / 2);
    g.addColorStop(0, 'rgba(12,13,26,.92)');
    g.addColorStop(1, 'rgba(22,18,44,.92)');
    ctx.shadowColor = withAlpha(st.color, 0.6);
    ctx.shadowBlur = cardH * 0.3;
    ctx.fillStyle = g;
    rr(ctx, -cardW / 2, -cardH / 2, cardW, cardH, cardH * 0.28);
    ctx.fill();
    ctx.shadowBlur = 0;
    const border = ctx.createConicGradient(t / 900, 0, 0);
    border.addColorStop(0, st.color);
    border.addColorStop(0.5, st.color2);
    border.addColorStop(1, st.color);
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(2, cardH * 0.03);
    ctx.stroke();
    const icon = cardH * 0.5;
    ctx.font = `${icon}px "Segoe UI Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const bob = 1 + 0.08 * Math.sin(t / 180) * (1 - clamp(t / 1500, 0, 1));
    ctx.save();
    ctx.translate(-cardW / 2 + cardH * 0.55, 0);
    ctx.scale(bob, bob);
    ctx.fillText(st.emoji, 0, cardH * 0.02);
    ctx.restore();
    const tx = -cardW / 2 + cardH * 1.05;
    const maxTW = cardW - cardH * 1.25;
    ctx.textAlign = 'left';
    ctx.font = `800 ${cardH * 0.26}px ${DISPLAY_FONT}`;
    const tg = ctx.createLinearGradient(tx, 0, tx + maxTW, 0);
    const sweep = ((t / 1600) % 1.6) - 0.3;
    tg.addColorStop(0, '#ffffff');
    tg.addColorStop(clamp(sweep, 0, 1), '#ffffff');
    tg.addColorStop(clamp(sweep + 0.08, 0, 1), st.color2);
    tg.addColorStop(clamp(sweep + 0.16, 0, 1), '#ffffff');
    tg.addColorStop(1, '#ffffff');
    ctx.fillStyle = tg;
    ctx.fillText(a.user || 'Someone', tx, -cardH * 0.13, maxTW);
    ctx.font = `600 ${cardH * 0.15}px ${UI_FONT}`;
    ctx.fillStyle = st.color2;
    ctx.fillText(a.title || '', tx, cardH * 0.14, maxTW);
    if (a.message) {
      ctx.font = `500 ${cardH * 0.11}px ${UI_FONT}`;
      ctx.fillStyle = 'rgba(235,236,255,.75)';
      ctx.fillText(`“${a.message.slice(0, 90)}”`, tx, cardH * 0.34, maxTW);
    }
    ctx.restore();
    this.drawConfetti(ctx, w, h, a, t, st, alpha);
  }

  drawConfetti(ctx, w, h, a, t, st, alpha) {
    if (!a.particles) {
      const cols = [st.color, st.color2, '#ffffff', '#fde047', '#f472b6'];
      a.particles = Array.from({ length: 70 }, () => ({
        x: w / 2 + (Math.random() - 0.5) * w * 0.3, y: h / 2,
        vx: (Math.random() - 0.5) * w * 1.1, vy: -(0.6 + Math.random() * 0.9) * h * 1.6,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 10, s: 4 + Math.random() * 7,
        c: cols[Math.floor(Math.random() * cols.length)],
      }));
    }
    const sec = Math.max(0, t - 120) / 1000;
    if (sec > 3) return;
    ctx.save();
    ctx.globalAlpha = alpha * clamp(1 - (sec - 2) / 1, 0, 1);
    const scale = Math.max(1, h / 300);
    for (const p of a.particles) {
      const x = p.x + p.vx * sec;
      const y = p.y + p.vy * sec + 0.5 * h * 3.2 * sec * sec;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.r + p.vr * sec);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s * scale / 2, -p.s * scale / 4, p.s * scale, p.s * scale / 2);
      ctx.restore();
    }
    ctx.restore();
  }
}

// ---- voice-reactive avatar (PNGtuber) -------------------------------------------------
class AvatarSource extends BaseSource {
  async start() {
    this.ready = true;
    this.talk = 0;
    this.phase = 0;
    this.last = performance.now();
    this.holdUntil = 0;
    this.level = 0;
    this.mouth = 0;
    this.blink = 0;
    this.blinkAt = performance.now() + 1500;
    this.look = { x: 0, y: 0, tx: 0, ty: 0, at: 0 };
    this.happy = 0;
    this.happyUntil = 0;
    this.jump = 0;
    this.off = this.mgr.on('alert', () => { this.happyUntil = performance.now() + 2600; });
    await this.loadImages();
  }

  stop() { if (this.off) this.off(); }

  async loadImages() {
    const s = this.s;
    this.idle = s.idle ? await loadImage(s.idle).catch(() => null) : null;
    this.talkImg = s.talk ? await loadImage(s.talk).catch(() => null) : null;
    this.blinkImg = s.blinkImg ? await loadImage(s.blinkImg).catch(() => null) : null;
    this.mgr.emit('source-ready', this.id);
  }

  async update(def, prev) {
    this.def = def;
    if (prev.idle !== def.settings.idle || prev.talk !== def.settings.talk || prev.blinkImg !== def.settings.blinkImg) await this.loadImages();
  }

  // Blinks (sometimes twice), glances around, celebrates alerts.
  animate(now, dt) {
    const s = this.s;
    const db = this.mgr.audio.level(s.inputId || 'mic');
    const thr = s.threshold ?? -38;
    if (db > thr) this.holdUntil = now + 160;
    const target = now < this.holdUntil ? 1 : 0;
    this.talk += (target - this.talk) * Math.min(1, dt * (target ? 22 : 9));
    this.level = clamp((db - thr) / 25, 0, 1);
    const mouthTarget = this.talk * (0.3 + 0.7 * this.level) * (0.8 + 0.2 * Math.sin(now / 45));
    this.mouth += (mouthTarget - this.mouth) * Math.min(1, dt * 25);
    this.phase += dt * (6 + 6 * this.talk);
    if (s.blinking !== false) {
      const BL = 150;
      if (now >= this.blinkAt) {
        const p = (now - this.blinkAt) / BL;
        this.blink = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
        if (p >= 1) {
          this.blink = 0;
          this.blinkAt = now + (Math.random() < 0.18 ? 120 : 2200 + Math.random() * 4200);
        }
      }
    } else this.blink = 0;
    const L = this.look;
    if (now > L.at) {
      const glance = Math.random() < 0.55;
      L.tx = glance ? (Math.random() * 2 - 1) * 0.9 : 0;
      L.ty = glance ? (Math.random() * 2 - 1) * 0.5 : 0;
      L.at = now + 900 + Math.random() * 3200;
    }
    L.x += (L.tx - L.x) * Math.min(1, dt * 9);
    L.y += (L.ty - L.y) * Math.min(1, dt * 9);
    const happyTarget = now < this.happyUntil ? 1 : 0;
    this.happy += (happyTarget - this.happy) * Math.min(1, dt * 8);
    this.jump = happyTarget ? Math.abs(Math.sin((now - (this.happyUntil - 2600)) / 160)) * this.happy * 0.6 : this.jump * 0.85;
  }

  natural() {
    const a = this.idle || this.talkImg;
    return a ? { w: a.w, h: a.h } : { w: 400, h: 400 };
  }

  draw(ctx, w, h, o) {
    const s = this.s;
    const now = o.now;
    if (o.canvas === 'h' || !this.lastUpdate || now - this.lastUpdate > 5) {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.lastUpdate = now;
      this.animate(now, dt);
    }
    const bounce = (s.bounce ?? 1) * this.talk;
    const breathe = 1 + Math.sin(now / 650) * 0.012;
    const by = -Math.abs(Math.sin(this.phase)) * h * 0.05 * bounce;
    const sq = (1 + 0.035 * Math.sin(this.phase * 2) * bounce) * breathe;
    ctx.translate(w / 2, h + by);
    ctx.scale(1 / sq, sq);
    ctx.translate(-w / 2, -h);
    const asset = this.blink > 0.5 && this.blinkImg ? this.blinkImg : this.talk > 0.5 && this.talkImg ? this.talkImg : this.idle;
    if (asset) {
      const fr = imageFrame(asset, now - this.t0);
      const sc = Math.min(w / asset.w, h / asset.h);
      const dw = asset.w * sc;
      const dh = asset.h * sc;
      ctx.drawImage(fr, (w - dw) / 2, h - dh - this.jump * h * 0.12, dw, dh);
      return;
    }
    drawAvatar(ctx, w, h, {
      style: s.style || 'blob', color: s.color || AVATAR_COLORS[s.style || 'blob'], accessory: s.accessory || 'none',
      t: now / 1000, talk: this.talk, level: this.level, mouth: this.mouth, blink: this.blink,
      lookX: this.look.x, lookY: this.look.y, happy: this.happy, jump: this.jump, squash: bounce * Math.sin(this.phase * 2),
    });
  }
}

// ---- browser source ---------------------------------------------------------------------
class BrowserSource extends BaseSource {
  async start() {
    this.frame = null;
    await this.push();
  }

  cfg() {
    const s = this.s;
    return { url: s.url || '', width: s.width || 1280, height: s.height || 720, fps: s.fps || 30, css: s.css || '', muted: !!s.muted };
  }

  async push(reload) {
    await window.lc.invoke('browser:set', this.id, { ...this.cfg(), reload: !!reload });
  }

  async update(def) {
    this.def = def;
    await this.push();
  }

  reload() { return this.push(true); }

  onFrame(w, h, data) {
    try {
      const f = new VideoFrame(data, { format: 'BGRA', codedWidth: w, codedHeight: h, timestamp: 0 });
      if (this.frame) this.frame.close();
      this.frame = f;
      if (!this.ready) {
        this.ready = true;
        this.mgr.emit('source-ready', this.id);
      }
    } catch (err) {
      this.error = String(err.message || err);
    }
  }

  stop() {
    window.lc.invoke('browser:remove', this.id);
    if (this.frame) this.frame.close();
    this.frame = null;
  }

  natural() {
    const c = this.cfg();
    return { w: c.width, h: c.height };
  }

  draw(ctx, w, h, o) {
    const f = this.frame;
    if (!f) return;
    drawCropped(ctx, f, f.displayWidth, f.displayHeight, w, h, o.crop);
  }
}

const TYPES = {
  display: CaptureSource, window: CaptureSource, camera: CameraSource, image: ImageSource, media: MediaFileSource,
  text: TextSource, timer: TimerSource, color: ColorSource, chat: ChatOverlaySource, alerts: AlertsSource,
  avatar: AvatarSource, browser: BrowserSource,
};

export const SOURCE_TYPES = Object.keys(TYPES);

export class SourceManager extends Emitter {
  constructor(audio, chat) {
    super();
    this.audio = audio;
    this.chat = chat;
    this.runtimes = new Map();
    this.images = new Map();
    window.lc.on('browser:frame', (id, w, h, data) => {
      const r = this.runtimes.get(id);
      if (r && r.onFrame) r.onFrame(w, h, data);
      window.lc.send('browser:ack', id);
    });
  }

  image(url) {
    let img = this.images.get(url);
    if (!img) {
      img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = url;
      this.images.set(url, img);
      if (this.images.size > 500) this.images.delete(this.images.keys().next().value);
    }
    return img;
  }

  get(id) { return this.runtimes.get(id) || null; }

  // Brings runtimes in line with state.sources (create / update / destroy).
  sync() {
    const defs = state.sources;
    for (const [id, r] of [...this.runtimes]) {
      if (!defs[id]) {
        r.stop();
        this.runtimes.delete(id);
      }
    }
    for (const def of Object.values(defs)) {
      const sig = JSON.stringify(def.settings || {});
      let r = this.runtimes.get(def.id);
      if (!r) {
        const Cls = TYPES[def.type];
        if (!Cls) continue;
        r = new Cls(def, this);
        r.sig = sig;
        r.prev = deepClone(def.settings || {});
        this.runtimes.set(def.id, r);
        r.start().catch((err) => { r.error = String(err.message || err); });
        continue;
      }
      r.def = def;
      if (sig !== r.sig) {
        const prev = r.prev;
        r.sig = sig;
        r.prev = deepClone(def.settings || {});
        r.update(def, prev).catch((err) => { r.error = String(err.message || err); });
      }
    }
  }

  stopAll() {
    for (const r of this.runtimes.values()) r.stop();
    this.runtimes.clear();
  }
}
