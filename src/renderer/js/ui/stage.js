// Preview stage: the 16:9 and 9:16 canvases side by side, a direct-manipulation
// editor (move, resize, snap guides, nudging), TikTok safe zones and vertical
// layout presets.
import { h, clear, onDrag } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, bus, commit, activeScene, canvasSize, verticalEnabled, autoLayout, coverRegion, PLATFORMS } from '../state.js';
import { app, registerPanel } from '../ctx.js';
import { segmented, contextMenu, select } from './common.js';
import { itemMenu, naturalOf, removeWithUndo, duplicateItem } from './items.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_POS = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export function mountStage(el) {
  const canvases = { h: h('canvas'), v: h('canvas') };
  app.compositor.attach('h', canvases.h);
  app.compositor.attach('v', canvases.v);
  const screens = {};
  let stage;
  let ro = null;
  let hoverId = null;
  let guides = [];
  let overlayQueued = false;

  function render() {
    clear(el);
    stage = h('div.stage');
    for (const key of ['h', 'v']) {
      const wrap = h('div.screen', { dataset: { key } });
      const label = h('div.screen-label');
      const editor = h('div.editor');
      wrap.append(h('div.screen-glow'), canvases[key], label, editor);
      wrap.addEventListener('pointerdown', (e) => {
        if (rt.editCanvas !== key) {
          e.stopPropagation();
          e.preventDefault();
          setEdit(key);
        }
      }, true);
      screens[key] = { wrap, editor, label, scale: 1 };
      bindEditor(key);
      stage.append(wrap);
    }
    el.append(toolbar(), stage);
    if (ro) ro.disconnect();
    ro = new ResizeObserver(layout);
    ro.observe(stage);
    layout();
  }

  function toolbar() {
    const v = verticalEnabled();
    const tr = state.settings.transition;
    return h('div.stage-toolbar',
      v ? segmented(rt.editCanvas, [
        { value: 'h', icon: 'tv', label: '16:9', title: t('Edit the landscape canvas') },
        { value: 'v', icon: 'phone', label: '9:16', title: t('Edit the vertical canvas') },
      ], setEdit) : h('span.muted', { style: { fontSize: '12px', fontWeight: 600 } }, '16:9'),
      h(`button.btn.btn-sm${v ? '.active' : ''}`, {
        title: t('Render a second, vertical 9:16 canvas for TikTok, Shorts and Reels'),
        onClick: () => app.actions.setVertical(!v),
      }, icon('phone', 14), v ? t('Dual canvas on') : t('Dual canvas off')),
      v ? h('button.btn.btn-sm', { onClick: (e) => presetMenu(e) }, icon('wand', 14), t('Vertical layout'), icon('chevDown', 12)) : null,
      h('div.grow'),
      h('span.muted', { style: { fontSize: '11.5px' } }, t('Transition')),
      select(tr.type, [
        { value: 'luma', label: 'Luma ring' }, { value: 'fade', label: t('Fade') }, { value: 'slide', label: t('Slide') },
        { value: 'zoom', label: t('Zoom') }, { value: 'wipe', label: t('Wipe') }, { value: 'cut', label: t('Cut') },
      ], (val) => { tr.type = val; commit('settings'); }),
      h('div.sep'),
      v ? h(`button.icon-btn${state.settings.safeZones ? '.on' : ''}`, { title: t('Show TikTok safe zones'), onClick: () => { state.settings.safeZones = !state.settings.safeZones; commit('settings'); render(); } }, icon('shield', 16)) : null,
      h(`button.icon-btn${state.settings.snap ? '.on' : ''}`, { title: t('Snap to edges and other sources (hold Alt to disable)'), onClick: () => { state.settings.snap = !state.settings.snap; commit('settings'); render(); } }, icon('magnet', 16)),
    );
  }

  function setEdit(key) {
    if (key === 'v' && !verticalEnabled()) key = 'h';
    rt.editCanvas = key;
    for (const k of ['h', 'v']) screens[k] && screens[k].wrap.classList.toggle('editing', k === key);
    const seg = el.querySelector('.seg');
    if (seg && seg.set) seg.set(key);
    bus.emit('editCanvas');
    scheduleOverlay();
  }

  function layout() {
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const W = r.width - 30;
    const H = r.height - 30;
    const hs = canvasSize('h');
    const vs = canvasSize('v');
    const ar = hs.w / hs.h;
    const av = vs.w / vs.h;
    const vert = verticalEnabled();
    let hw;
    let hh;
    let vw = 0;
    let vh = 0;
    if (vert) {
      const hgt = Math.max(60, Math.min(H, (W - 14) / (ar + av)));
      hh = hgt;
      hw = hgt * ar;
      vh = hgt;
      vw = hgt * av;
    } else {
      hw = Math.max(100, Math.min(W, H * ar));
      hh = hw / ar;
    }
    Object.assign(screens.h.wrap.style, { width: `${hw}px`, height: `${hh}px` });
    screens.h.scale = hw / hs.w;
    screens.v.wrap.classList.toggle('hidden', !vert);
    if (vert) {
      Object.assign(screens.v.wrap.style, { width: `${vw}px`, height: `${vh}px` });
      screens.v.scale = vw / vs.w;
    }
    if (!vert && rt.editCanvas === 'v') rt.editCanvas = 'h';
    for (const k of ['h', 'v']) screens[k].wrap.classList.toggle('editing', k === rt.editCanvas);
    updateLabels();
    scheduleOverlay();
  }

  function updateLabels() {
    for (const key of ['h', 'v']) {
      const s = screens[key];
      if (!s) continue;
      const dests = state.destinations.filter((d) => d.enabled && (d.canvas === 'v' && verticalEnabled() ? 'v' : 'h') === key);
      const { w, h: hh } = canvasSize(key);
      clear(s.label).append(
        h('span', key === 'v' ? '9:16' : '16:9'),
        ...(dests.length
          ? dests.map((d) => h('span.row-gap', { style: { gap: '4px' } }, h('span.pf', { style: { background: (PLATFORMS[d.platform] || PLATFORMS.custom).color } }), d.name))
          : [h('span.muted', `${w}×${hh}`)]),
      );
    }
  }

  // ---- overlay ---------------------------------------------------------------------
  function scheduleOverlay() {
    if (overlayQueued) return;
    overlayQueued = true;
    requestAnimationFrame(() => {
      overlayQueued = false;
      drawOverlay();
    });
  }

  const box = (L, sc) => ({
    left: `${L.x * sc}px`, top: `${L.y * sc}px`, width: `${Math.max(1, L.w * sc)}px`, height: `${Math.max(1, L.h * sc)}px`,
    transform: L.rot ? `rotate(${L.rot}deg)` : '',
  });

  function drawOverlay() {
    const scene = activeScene();
    for (const key of ['h', 'v']) {
      const s = screens[key];
      if (!s) continue;
      const ed = clear(s.editor);
      const sc = s.scale;
      const { w: W, h: H } = canvasSize(key);
      if (key === 'v' && state.settings.safeZones && verticalEnabled()) {
        const z = (x, y, w, hh, label) => h('div.safe-zone', { style: box({ x: W * x, y: H * y, w: W * w, h: H * hh }, sc) }, label);
        ed.append(z(0, 0, 1, 0.085, ''), z(0.835, 0.4, 0.165, 0.42, ''), z(0, 0.82, 0.835, 0.18, t('TikTok UI')));
      }
      if (rt.editCanvas !== key || !scene) continue;
      for (const item of scene.items) {
        const L = item[key];
        if (!item.visible || !L || L.show === false || !L.auto) continue;
        const src = state.sources[item.sourceId];
        const r = app.mgr.get(item.sourceId);
        ed.append(h('div.pending-box', { style: box({ x: W * 0.3, y: H * 0.4, w: W * 0.4, h: H * 0.2 }, sc) },
          r && r.error ? `${src.name}: ${t(r.error)}` : t('Starting {name}…', { name: src.name })));
      }
      const hover = hoverId && hoverId !== rt.selection ? scene.items.find((i) => i.id === hoverId) : null;
      if (hover && !hover[key].auto) ed.append(h('div.hover-box', { style: box(hover[key], sc) }));
      const sel = scene.items.find((i) => i.id === rt.selection);
      if (sel && sel.visible && sel[key] && sel[key].show !== false && !sel[key].auto) {
        const src = state.sources[sel.sourceId];
        const b = h(`div.sel-box${sel.locked ? '.locked' : ''}`, { style: box(sel[key], sc) }, h('div.sel-name', src ? src.name : ''));
        if (!sel.locked) {
          for (const hd of HANDLES) {
            const [px, py] = HANDLE_POS[hd];
            b.append(h('div.handle', { dataset: { handle: hd }, style: { left: `${px}%`, top: `${py}%`, cursor: CURSORS[hd] } }));
          }
        }
        ed.append(b);
      }
      for (const g of guides) {
        ed.append(h(`div.guide.${g.axis}`, { style: g.axis === 'v' ? { left: `${g.at * sc}px` } : { top: `${g.at * sc}px` } }));
      }
    }
  }

  // ---- interaction --------------------------------------------------------------------
  function pt(e, key) {
    const r = screens[key].editor.getBoundingClientRect();
    const sc = screens[key].scale;
    return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  }

  function hitTest(key, p) {
    const scene = activeScene();
    if (!scene) return null;
    for (let i = scene.items.length - 1; i >= 0; i--) {
      const it = scene.items[i];
      const L = it[key];
      if (!it.visible || !L || L.show === false || L.auto) continue;
      if (p.x >= L.x && p.x <= L.x + L.w && p.y >= L.y && p.y <= L.y + L.h) return it;
    }
    return null;
  }

  function snapTargets(key, skip) {
    const { w: W, h: H } = canvasSize(key);
    const xs = [0, W / 2, W];
    const ys = [0, H / 2, H];
    const scene = activeScene();
    for (const it of scene.items) {
      if (it === skip || !it.visible) continue;
      const L = it[key];
      if (!L || L.show === false || L.auto) continue;
      xs.push(L.x, L.x + L.w / 2, L.x + L.w);
      ys.push(L.y, L.y + L.h / 2, L.y + L.h);
    }
    return { xs, ys };
  }

  // Returns the correction for the closest edge within `dist`, plus guide position.
  function snapEdges(edges, targets, dist) {
    let best = null;
    for (const e of edges) {
      for (const tgt of targets) {
        const d = tgt - e;
        if (Math.abs(d) <= dist && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: tgt };
      }
    }
    return best;
  }

  function bindEditor(key) {
    const ed = screens[key].editor;
    ed.addEventListener('pointerdown', (e) => onDown(e, key));
    ed.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const hit = hitTest(key, pt(e, key));
      const id = hit ? hit.id : null;
      ed.style.cursor = e.target.dataset.handle ? CURSORS[e.target.dataset.handle] : hit && !hit.locked ? 'move' : 'default';
      if (id !== hoverId) {
        hoverId = id;
        scheduleOverlay();
      }
    });
    ed.addEventListener('pointerleave', () => { hoverId = null; scheduleOverlay(); });
    ed.addEventListener('dblclick', (e) => {
      const hit = hitTest(key, pt(e, key));
      if (hit) app.actions.openProperties(hit.id);
    });
    ed.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = hitTest(key, pt(e, key));
      if (!hit) return;
      rt.selection = hit.id;
      bus.emit('selection');
      itemMenu(activeScene(), hit, e.clientX, e.clientY);
    });
  }

  function onDown(e, key) {
    if (e.button !== 0) return;
    const scene = activeScene();
    if (!scene) return;
    const handle = e.target.dataset ? e.target.dataset.handle : null;
    const p0 = pt(e, key);
    const item = handle ? scene.items.find((i) => i.id === rt.selection) : hitTest(key, p0);
    if (!item) {
      if (rt.selection) {
        rt.selection = null;
        bus.emit('selection');
      }
      return;
    }
    if (rt.selection !== item.id) {
      rt.selection = item.id;
      bus.emit('selection');
    }
    if (item.locked) return;
    const L = item[key];
    const start = { x: L.x, y: L.y, w: L.w, h: L.h };
    const aspect = start.w / Math.max(1, start.h);
    const dist = 8 / screens[key].scale;
    const targets = snapTargets(key, item);
    let moved = false;
    onDrag(e, (ev) => {
      const p = pt(ev, key);
      const dx = p.x - p0.x;
      const dy = p.y - p0.y;
      if (!moved && Math.hypot(dx, dy) * screens[key].scale < 2) return;
      moved = true;
      const snap = state.settings.snap && !ev.altKey;
      guides = [];
      if (!handle) {
        let nx = start.x + dx;
        let ny = start.y + dy;
        if (snap) {
          const sx = snapEdges([nx, nx + start.w / 2, nx + start.w], targets.xs, dist);
          if (sx) { nx += sx.d; guides.push({ axis: 'v', at: sx.at }); }
          const sy = snapEdges([ny, ny + start.h / 2, ny + start.h], targets.ys, dist);
          if (sy) { ny += sy.d; guides.push({ axis: 'h', at: sy.at }); }
        }
        L.x = Math.round(nx);
        L.y = Math.round(ny);
      } else {
        let x1 = start.x;
        let y1 = start.y;
        let x2 = start.x + start.w;
        let y2 = start.y + start.h;
        if (handle.includes('w')) x1 += dx;
        if (handle.includes('e')) x2 += dx;
        if (handle.includes('n')) y1 += dy;
        if (handle.includes('s')) y2 += dy;
        if (snap) {
          if (handle.includes('w') || handle.includes('e')) {
            const edge = handle.includes('w') ? x1 : x2;
            const s = snapEdges([edge], targets.xs, dist);
            if (s) { if (handle.includes('w')) x1 += s.d; else x2 += s.d; guides.push({ axis: 'v', at: s.at }); }
          }
          if (handle.includes('n') || handle.includes('s')) {
            const edge = handle.includes('n') ? y1 : y2;
            const s = snapEdges([edge], targets.ys, dist);
            if (s) { if (handle.includes('n')) y1 += s.d; else y2 += s.d; guides.push({ axis: 'h', at: s.at }); }
          }
        }
        const corner = handle.length === 2;
        if (corner && !ev.shiftKey) {
          // keep aspect ratio, driven by the dominant axis
          let w = Math.max(8, x2 - x1);
          let hh = Math.max(8, y2 - y1);
          if (w / aspect > hh) hh = w / aspect;
          else w = hh * aspect;
          if (handle.includes('w')) x1 = x2 - w; else x2 = x1 + w;
          if (handle.includes('n')) y1 = y2 - hh; else y2 = y1 + hh;
          guides = [];
        }
        L.x = Math.round(Math.min(x1, x2));
        L.y = Math.round(Math.min(y1, y2));
        L.w = Math.round(Math.max(8, Math.abs(x2 - x1)));
        L.h = Math.round(Math.max(8, Math.abs(y2 - y1)));
      }
      scheduleOverlay();
    }, () => {
      guides = [];
      if (moved) commit('items');
      scheduleOverlay();
    });
  }

  // keyboard: nudge / delete / duplicate
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const scene = activeScene();
    const item = scene && scene.items.find((i) => i.id === rt.selection);
    if (!item) return;
    const L = item[rt.editCanvas];
    const step = e.shiftKey ? 10 : 1;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (nudge && !item.locked) {
      e.preventDefault();
      L.x += nudge[0];
      L.y += nudge[1];
      scheduleOverlay();
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => commit('items'), 400);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeWithUndo(scene, item);
    } else if (e.key === 'd' && e.ctrlKey) {
      e.preventDefault();
      duplicateItem(scene, item);
    } else if (e.key === 'Escape') {
      rt.selection = null;
      bus.emit('selection');
    }
  });
  let nudgeTimer = null;

  // ---- 9:16 layout presets ---------------------------------------------------------------
  function presetMenu(e) {
    const b = e.currentTarget.getBoundingClientRect();
    contextMenu(b.left, b.bottom + 6, [
      { title: t('Arrange the 9:16 canvas') },
      { label: t('Smart (fill + cam on top)'), icon: 'sparkles', onClick: () => applyPreset('smart') },
      { label: t('Split: cam top, gameplay bottom'), icon: 'layout', onClick: () => applyPreset('stack') },
      { label: t('Full gameplay + cam bubble'), icon: 'smile', onClick: () => applyPreset('bubble') },
      { label: t('Letterbox (same as 16:9)'), icon: 'tv', onClick: () => applyPreset('letterbox') },
    ]);
  }

  function applyPreset(name) {
    const scene = activeScene();
    if (!scene) return;
    const { w: W, h: H } = canvasSize('v');
    const hs = canvasSize('h');
    const typeOf = (it) => (state.sources[it.sourceId] || {}).type;
    const isGame = (it) => ['display', 'window', 'media'].includes(typeOf(it));
    const isCam = (it) => typeOf(it) === 'camera';
    for (const it of scene.items) {
      const nat = naturalOf(it);
      const type = typeOf(it);
      const prev = it.v;
      let L;
      if (name === 'letterbox') {
        const s = W / hs.w;
        const off = (H - hs.h * s) / 2;
        const src = it.h;
        L = { ...src, x: src.x * s, y: src.y * s + off, w: src.w * s, h: src.h * s, crop: { ...(src.crop || {}) } };
      } else if (name === 'stack' && nat && (isGame(it) || isCam(it))) {
        const camH = Math.round(H * 0.36);
        L = isCam(it) ? { ...autoLayout(type, nat, 'v'), ...coverRegion(nat.w, nat.h, 0, 0, W, camH) } : { ...autoLayout(type, nat, 'v'), ...coverRegion(nat.w, nat.h, 0, camH, W, H - camH) };
      } else if (name === 'bubble' && nat && isCam(it)) {
        const size = Math.round(W * 0.4);
        L = { ...autoLayout(type, nat, 'v'), ...coverRegion(nat.w, nat.h, Math.round(W * 0.05), Math.round(H * 0.1), size, size) };
      } else if (name === 'bubble' && nat && isGame(it)) {
        L = { ...autoLayout(type, nat, 'v'), ...coverRegion(nat.w, nat.h, 0, 0, W, H) };
      } else {
        L = autoLayout(type, nat, 'v');
      }
      for (const k of ['x', 'y', 'w', 'h']) L[k] = Math.round(L[k]);
      L.show = prev.show !== false;
      L.auto = false;
      it.v = L;
    }
    commit('items');
  }

  for (const ev of ['items', 'selection', 'activeScene', 'sources']) bus.on(ev, scheduleOverlay);
  bus.on('destinations', updateLabels);
  bus.on('settings', () => { layout(); });
  bus.on('video', () => render());
  setInterval(() => {
    // pending boxes and labels change as sources come up
    const scene = activeScene();
    if (scene && scene.items.some((i) => i[rt.editCanvas] && i[rt.editCanvas].auto)) scheduleOverlay();
  }, 700);
  render();
  return registerPanel({ render, layout, scheduleOverlay, setEdit });
}
