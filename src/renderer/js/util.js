// Small DOM + math helpers shared by every renderer module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// h('div.card#id', { onClick, style, ... }, ...children)
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props !== undefined && (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof el[k] !== 'function' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
};

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function debounce(fn, ms) {
  let timer = null;
  const d = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  d.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return d;
}

export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  off(ev, fn) { const s = this._l.get(ev); if (s) s.delete(fn); }
  emit(ev, ...args) {
    const s = this._l.get(ev);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...args); } catch (err) { console.error(`[${ev}]`, err); }
    }
  }
}

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g <= 0.00001 ? -100 : 20 * Math.log10(g));

export function hashColor(str) {
  let hsh = 0;
  for (let i = 0; i < str.length; i++) hsh = (hsh * 31 + str.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hsh) % 360} 80% 68%)`;
}

export function fileUrl(p) {
  if (!p) return '';
  if (/^(https?|file|data|blob):/i.test(p)) return p;
  const norm = p.replace(/\\/g, '/');
  return `file:///${norm.split('/').map((s, i) => (i === 0 && /:$/.test(s) ? s : encodeURIComponent(s))).join('/')}`;
}

export const deepClone = (o) => JSON.parse(JSON.stringify(o));

export function onDrag(e, move, up) {
  e.preventDefault();
  const mm = (ev) => move(ev);
  const mu = (ev) => {
    window.removeEventListener('pointermove', mm);
    window.removeEventListener('pointerup', mu);
    if (up) up(ev);
  };
  window.addEventListener('pointermove', mm);
  window.addEventListener('pointerup', mu);
}

// Animate a number on an element (used for counters in the recap).
export function countUp(el, to, ms = 900, fmt = (v) => Math.round(v).toLocaleString()) {
  const start = performance.now();
  const step = (now) => {
    const t = clamp((now - start) / ms, 0, 1);
    el.textContent = fmt(to * ease.outCubic(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
