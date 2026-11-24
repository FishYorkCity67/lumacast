// Renders the active scene into the 16:9 and 9:16 canvases at a fixed rate,
// with animated scene transitions and the Privacy Shield overlay.
import { Emitter, clamp, ease } from './util.js';
import { state, rt, getScene, activeScene, canvasSize, verticalEnabled, autoLayout, commit, isBoxed } from './state.js';

const TICKER_SRC = `
let timer = null, interval = 1000 / 60, next = 0;
function loop() {
  postMessage(0);
  next += interval;
  const now = performance.now();
  if (next < now - interval) next = now;
  timer = setTimeout(loop, Math.max(0, next - now));
}
onmessage = (e) => { interval = 1000 / e.data; clearTimeout(timer); next = performance.now(); loop(); };
`;

export class Compositor extends Emitter {
  constructor(mgr) {
    super();
    this.mgr = mgr;
    this.canvases = {};
    this.trans = null;
    this.privacy = 0;
    this.privacyTarget = 0;
    this.renderMs = 0;
    this.fps = 0;
    this.frameHooks = [];
    this.ticks = 0;
    this.fpsCount = 0;
    this.fpsAt = performance.now();
    mgr.on('source-ready', () => { this.autoPending = true; });
  }

  attach(key, canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    this.canvases[key] = { key, el: canvas, ctx, bufs: {} };
    this.applySize(key);
  }

  applySize(key) {
    const c = this.canvases[key];
    if (!c) return;
    const { w, h } = canvasSize(key);
    if (c.el.width !== w || c.el.height !== h) {
      c.el.width = w;
      c.el.height = h;
      c.bufs = {};
      c.ctx.imageSmoothingQuality = 'high';
    }
  }

  tickRate() {
    const v = state.settings.video;
    return Math.max(v.h.fps, verticalEnabled() ? v.v.fps : 0);
  }

  start() {
    try {
      const url = URL.createObjectURL(new Blob([TICKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = () => this.tick();
      this.worker.postMessage(this.tickRate());
    } catch {
      const loop = () => {
        this.tick();
        this.fallback = setTimeout(loop, 1000 / this.tickRate());
      };
      loop();
    }
  }

  restartTicker() {
    if (this.worker) this.worker.postMessage(this.tickRate());
  }

  // ---- scenes & transitions ------------------------------------------------------
  switchTo(id, opts = {}) {
    if (!getScene(id) || id === state.activeSceneId) return;
    const prev = state.activeSceneId;
    state.activeSceneId = id;
    rt.selection = null;
    const tr = opts.transition || state.settings.transition;
    this.trans = tr.type !== 'cut' && tr.ms > 0 ? { from: prev, to: id, start: performance.now(), dur: tr.ms, type: tr.type } : null;
    for (const item of getScene(id).items) {
      const r = this.mgr.get(item.sourceId);
      if (r) r.onShow();
    }
    commit('activeScene', id);
  }

  setPrivacy(on) { this.privacyTarget = on ? 1 : 0; }

  // ---- frame loop ---------------------------------------------------------------------
  tick() {
    const now = performance.now();
    const dt = this.lastTick ? now - this.lastTick : 16;
    this.lastTick = now;
    const step = dt / 260;
    this.privacy = this.privacy < this.privacyTarget ? Math.min(this.privacyTarget, this.privacy + step) : Math.max(this.privacyTarget, this.privacy - step);
    if (this.autoPending || ++this.ticks % 30 === 0) this.runAutoLayouts();
    const t0 = performance.now();
    const v = state.settings.video;
    for (const key of ['h', 'v']) {
      const c = this.canvases[key];
      if (!c || (key === 'v' && !verticalEnabled())) continue;
      // each canvas renders at its own frame rate; encoders sample only fresh frames
      const interval = 1000 / v[key].fps;
      if (c.renderedAt && now - c.renderedAt < interval * 0.75) continue;
      c.renderedAt = now;
      this.renderCanvas(c, key, now);
    }
    if (this.trans && now - this.trans.start >= this.trans.dur) this.trans = null;
    this.renderMs = this.renderMs * 0.92 + (performance.now() - t0) * 0.08;
    this.fpsCount++;
    if (now - this.fpsAt >= 1000) {
      this.fps = Math.round((this.fpsCount * 1000) / (now - this.fpsAt));
      this.fpsCount = 0;
      this.fpsAt = now;
    }
    for (const fn of this.frameHooks) {
      try { fn(now); } catch (err) { console.error('frame hook', err); }
    }
  }

  buffer(c, name, w, h) {
    let b = c.bufs[name];
    if (!b || b.canvas.width !== w || b.canvas.height !== h) {
      const canvas = new OffscreenCanvas(w, h);
      b = { canvas, ctx: canvas.getContext('2d', { alpha: false }) };
      b.ctx.imageSmoothingQuality = 'high';
      c.bufs[name] = b;
    }
    return b;
  }

  renderCanvas(c, key, now) {
    const { ctx, el } = c;
    const W = el.width;
    const H = el.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const tr = this.trans;
    if (tr && now - tr.start < tr.dur) {
      this.drawTransition(c, key, tr, now, W, H);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      this.drawScene(ctx, key, activeScene(), now);
    }
    if (this.privacy > 0.01) this.drawPrivacyBadge(ctx, W, H, this.privacy, now);
  }

  drawScene(ctx, key, scene, now) {
    if (!scene) return;
    for (const item of scene.items) {
      if (!item.visible) continue;
      const L = item[key];
      if (!L || L.show === false || L.auto) continue;
      const src = this.mgr.get(item.sourceId);
      if (!src) continue;
      ctx.save();
      ctx.globalAlpha = L.opacity ?? 1;
      if (L.rot) {
        ctx.translate(L.x + L.w / 2, L.y + L.h / 2);
        ctx.rotate((L.rot * Math.PI) / 180);
        ctx.translate(-L.w / 2, -L.h / 2);
      } else ctx.translate(L.x, L.y);
      try {
        src.draw(ctx, L.w, L.h, { crop: L.crop, now, canvas: key, privacy: src.shieldable ? this.privacy : 0, item });
      } catch (err) {
        if (!src._warned) {
          src._warned = true;
          console.warn('draw failed', src.type, err);
        }
      }
      ctx.restore();
    }
  }

  drawTransition(c, key, tr, now, W, H) {
    const ctx = c.ctx;
    const p = ease.inOutCubic(clamp((now - tr.start) / tr.dur, 0, 1));
    const A = this.buffer(c, 'a', W, H);
    const B = this.buffer(c, 'b', W, H);
    for (const [buf, id] of [[A, tr.from], [B, tr.to]]) {
      buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
      buf.ctx.globalAlpha = 1;
      buf.ctx.fillStyle = '#000';
      buf.ctx.fillRect(0, 0, W, H);
      this.drawScene(buf.ctx, key, getScene(id), now);
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    switch (tr.type) {
      case 'slide':
        ctx.drawImage(A.canvas, -p * W, 0);
        ctx.drawImage(B.canvas, (1 - p) * W, 0);
        break;
      case 'zoom': {
        ctx.save();
        ctx.globalAlpha = 1 - p;
        const sa = 1 + 0.18 * p;
        ctx.translate(W / 2, H / 2);
        ctx.scale(sa, sa);
        ctx.drawImage(A.canvas, -W / 2, -H / 2);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = p;
        const sb = 0.9 + 0.1 * p;
        ctx.translate(W / 2, H / 2);
        ctx.scale(sb, sb);
        ctx.drawImage(B.canvas, -W / 2, -H / 2);
        ctx.restore();
        break;
      }
      case 'wipe': {
        ctx.drawImage(A.canvas, 0, 0);
        const edge = p * (W + H * 0.6);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(edge, 0);
        ctx.lineTo(edge - H * 0.6, H);
        ctx.lineTo(0, H);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(B.canvas, 0, 0);
        ctx.restore();
        ctx.save();
        const g = ctx.createLinearGradient(edge - H * 0.3 - 40, 0, edge - H * 0.3 + 40, 0);
        g.addColorStop(0, 'rgba(124,92,255,0)');
        g.addColorStop(0.5, 'rgba(160,220,255,.9)');
        g.addColorStop(1, 'rgba(34,211,238,0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(4, W * 0.006);
        ctx.beginPath();
        ctx.moveTo(edge, 0);
        ctx.lineTo(edge - H * 0.6, H);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'luma': {
        ctx.drawImage(A.canvas, 0, 0);
        const R = Math.hypot(W, H) / 2;
        const r = R * p;
        ctx.save();
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(B.canvas, 0, 0);
        ctx.restore();
        if (p < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - p;
          const ring = ctx.createConicGradient(now / 400, W / 2, H / 2);
          ring.addColorStop(0, '#7c5cff');
          ring.addColorStop(0.5, '#22d3ee');
          ring.addColorStop(1, '#7c5cff');
          ctx.strokeStyle = ring;
          ctx.lineWidth = Math.max(6, Math.min(W, H) * 0.012);
          ctx.shadowColor = '#7c5cff';
          ctx.shadowBlur = 30;
          ctx.beginPath();
          ctx.arc(W / 2, H / 2, Math.max(1, r), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        break;
      }
      case 'fade':
      default:
        ctx.drawImage(A.canvas, 0, 0);
        ctx.globalAlpha = p;
        ctx.drawImage(B.canvas, 0, 0);
        ctx.globalAlpha = 1;
    }
  }

  drawPrivacyBadge(ctx, W, H, p, now) {
    const m = Math.min(W, H);
    const k = ease.outBack(p);
    const text = state.settings.privacy.message || 'Privacy mode';
    const fs = m * 0.034;
    ctx.save();
    ctx.globalAlpha = p;
    ctx.font = `600 ${fs}px "Segoe UI Variable Text","Segoe UI",sans-serif`;
    const tw = ctx.measureText(text).width;
    const bw = tw + fs * 3.6;
    const bh = fs * 2.4;
    ctx.translate(W / 2, H / 2);
    ctx.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k);
    ctx.fillStyle = 'rgba(10,11,22,.82)';
    ctx.shadowColor = 'rgba(124,92,255,.55)';
    ctx.shadowBlur = fs * 1.5;
    ctx.beginPath();
    ctx.roundRect(-bw / 2, -bh / 2, bw, bh, bh / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    const g = ctx.createConicGradient(now / 700, 0, 0);
    g.addColorStop(0, '#7c5cff');
    g.addColorStop(0.5, '#22d3ee');
    g.addColorStop(1, '#7c5cff');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(2, fs * 0.08);
    ctx.stroke();
    // lock glyph
    const lx = -bw / 2 + fs * 1.4;
    ctx.strokeStyle = '#e8e9ff';
    ctx.fillStyle = '#e8e9ff';
    ctx.lineWidth = fs * 0.13;
    ctx.beginPath();
    ctx.arc(lx, -fs * 0.18, fs * 0.3, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(lx - fs * 0.45, -fs * 0.18, fs * 0.9, fs * 0.72, fs * 0.12);
    ctx.fill();
    ctx.fillStyle = '#f1f2ff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + fs * 0.95, fs * 0.04);
    ctx.restore();
  }

  // Items flagged `auto` get their default layout once the source knows its size.
  runAutoLayouts() {
    this.autoPending = false;
    let changed = false;
    for (const scene of state.scenes) {
      for (const item of scene.items) {
        for (const key of ['h', 'v']) {
          const L = item[key];
          if (!L || !L.auto) continue;
          const src = state.sources[item.sourceId];
          const r = this.mgr.get(item.sourceId);
          if (!src || !r) continue;
          const nat = r.natural();
          if (!nat && !isBoxed(src.type)) continue;
          const next = autoLayout(src.type, nat, key);
          if (L.yHint != null) next.y = Math.round(canvasSize(key).h * L.yHint - next.h / 2);
          next.show = L.show !== false;
          item[key] = next;
          changed = true;
        }
      }
    }
    if (changed) commit('items');
  }
}
