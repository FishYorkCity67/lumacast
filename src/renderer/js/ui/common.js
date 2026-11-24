// Generic UI building blocks: toasts, modals, context menus, form controls,
// segmented controls and tabs with sliding indicators.
import { h, $, clear, clamp } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

// ---- toasts ------------------------------------------------------------------------
export function toast(title, opts = {}) {
  const { text = '', type = 'info', actions = [], duration = type === 'err' ? 9000 : 5000 } = opts;
  const layer = $('#layer-toasts');
  const ic = { ok: 'check', err: 'warning', warn: 'warning', info: 'info' }[type] || 'info';
  const el = h(`div.toast.${type}`,
    icon(ic, 18),
    h('div.t-body',
      h('div.t-title', title),
      text ? h('div.t-text', text) : null,
      actions.length ? h('div.t-actions', actions.map((a) => h('button.btn.btn-sm', { onClick: () => { a.onClick(); close(); } }, a.label))) : null),
    h('button.icon-btn', { onClick: () => close(), title: t('Dismiss') }, icon('x', 14)),
    duration ? h('div.t-bar', { style: { animationDuration: `${duration}ms` } }) : null);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  if (duration) timer = setTimeout(close, duration);
  el.addEventListener('mouseenter', () => { clearTimeout(timer); const b = el.querySelector('.t-bar'); if (b) b.style.animationPlayState = 'paused'; });
  el.addEventListener('mouseleave', () => { if (duration) { timer = setTimeout(close, 2500); } });
  layer.appendChild(el);
  while (layer.children.length > 5) layer.firstChild.remove();
  return close;
}

// ---- modals ------------------------------------------------------------------------
const stack = [];

export function openModal({ title, sub, body, actions = [], left = [], width = 560, onClose, tabs, dismissable = true }) {
  const layer = $('#layer-modals');
  const foot = actions.length || left.length
    ? h('div.modal-foot', h('div.left', left), actions)
    : null;
  const modal = h('div.modal', { style: { '--w': `${width}px` } },
    h('div.modal-head',
      h('h2', title, sub ? h('span.sub', sub) : null),
      dismissable ? h('button.icon-btn', { onClick: () => close(), title: t('Close') }, icon('x', 16)) : null),
    tabs || null,
    h('div.modal-body', body),
    foot);
  const backdrop = h('div.modal-backdrop', modal);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissable) backdrop.dataset.down = '1';
  });
  backdrop.addEventListener('pointerup', (e) => {
    if (e.target === backdrop && backdrop.dataset.down) close();
    delete backdrop.dataset.down;
  });
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 200);
    if (onClose) onClose(result);
  };
  const api = { close, el: modal, body: modal.querySelector('.modal-body'), dismissable };
  stack.push(api);
  layer.appendChild(backdrop);
  setTimeout(() => {
    const f = modal.querySelector('[autofocus], .modal-body input:not([type=range]):not([type=checkbox]):not([type=color])');
    if (f) f.focus();
  }, 60);
  return api;
}

export const topModal = () => stack[stack.length - 1] || null;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const m = topModal();
    if (m && m.dismissable) {
      e.preventDefault();
      m.close();
    }
  }
});

export function confirmDialog(title, text, { ok = t('OK'), danger = false, cancel = t('Cancel') } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title, width: 440,
      body: h('p', { style: { margin: '4px 0 6px', color: 'var(--text-2)', lineHeight: '1.6' } }, text),
      actions: [
        h('button.btn.btn-ghost', { onClick: () => m.close() }, cancel),
        h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { autofocus: true, onClick: () => { result = true; m.close(); } }, ok),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title, value = '', { ok = t('Save'), placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, placeholder });
    const submit = () => { result = input.value.trim(); m.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const m = openModal({
      title, width: 420, body: input,
      actions: [h('button.btn.btn-ghost', { onClick: () => m.close() }, t('Cancel')), h('button.btn.btn-primary', { onClick: submit }, ok)],
      onClose: () => resolve(result || null),
    });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// ---- context menu -------------------------------------------------------------------
let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

export function contextMenu(x, y, items) {
  closeMenu();
  const el = h('div.menu', items.filter(Boolean).map((it) => {
    if (it === '-') return h('div.menu-sep');
    if (it.title) return h('div.menu-title', it.title);
    return h(`button.menu-item${it.danger ? '.danger' : ''}`, {
      onClick: () => { closeMenu(); it.onClick(); },
      disabled: it.disabled,
      style: it.disabled ? { opacity: 0.4, pointerEvents: 'none' } : null,
    }, it.icon ? icon(it.icon, 15) : h('span', { style: { width: '15px' } }), it.label, it.k ? h('span.k', it.k) : null);
  }));
  $('#layer-menu').appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${clamp(x, 6, window.innerWidth - r.width - 6)}px`;
  el.style.top = `${clamp(y, 6, window.innerHeight - r.height - 6)}px`;
  openMenuEl = el;
  return el;
}

window.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
}, true);
window.addEventListener('blur', closeMenu);

// ---- form controls ------------------------------------------------------------------
export function field(label, control, hint, opts = {}) {
  return h(`div.field${opts.stack ? '.stack' : ''}`, h('label', label), h('div.ctrl', control), hint ? h('div.hint', hint) : null);
}

export function textInput(value, onChange, opts = {}) {
  const el = h(`input.input${opts.mono ? '.mono' : ''}`, { type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '', spellcheck: false });
  el.addEventListener(opts.lazy ? 'change' : 'input', () => onChange(el.value));
  return el;
}

export function textArea(value, onChange, opts = {}) {
  const el = h('textarea.input', { placeholder: opts.placeholder || '', spellcheck: false });
  el.value = value ?? '';
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

export function numInput(value, onChange, { min, max, step = 1 } = {}) {
  const el = h('input.input.num', { type: 'number', value, min, max, step });
  el.addEventListener('change', () => {
    let v = Number(el.value);
    if (!Number.isFinite(v)) v = value;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    el.value = v;
    onChange(v);
  });
  return el;
}

export function rangeInput(value, onChange, { min = 0, max = 100, step = 1, fmt = (v) => v } = {}) {
  const el = h('input', { type: 'range', min, max, step, value });
  const out = h('span.range-val', fmt(value));
  const paint = () => el.style.setProperty('--p', `${((el.value - min) / (max - min)) * 100}%`);
  el.addEventListener('input', () => {
    paint();
    out.textContent = fmt(Number(el.value));
    onChange(Number(el.value));
  });
  paint();
  return h('div.ctrl', { style: { flex: 1 } }, el, out);
}

export function toggle(checked, onChange, opts = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label.switch', { title: opts.title || '' }, input, h('span.track'), h('span.knob'));
  el.input = input;
  return el;
}

export function select(value, options, onChange) {
  const el = h('select.select', options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function colorInput(value, onChange) {
  const el = h('input', { type: 'color', value: value || '#ffffff' });
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

export function fileInput(value, onChange, { filters, title } = {}) {
  const label = h('input.input', { value: value || '', placeholder: t('No file selected'), readOnly: true });
  const btn = h('button.btn.btn-sm', { onClick: async () => {
    const p = await window.lc.invoke('dialog:file', { filters, title: title || t('Choose a file') });
    if (p) {
      label.value = p;
      onChange(p);
    }
  } }, icon('folder', 14), t('Browse'));
  const clr = h('button.icon-btn', { title: t('Clear'), onClick: () => { label.value = ''; onChange(''); } }, icon('x', 14));
  return h('div.ctrl', { style: { flex: 1 } }, label, btn, clr);
}

// Segmented control with a sliding indicator.
export function segmented(value, options, onChange) {
  const ind = h('span.seg-ind');
  const btns = options.map((o) => h(`button${String(o.value) === String(value) ? '.on' : ''}`, {
    title: o.title || '',
    onClick: () => {
      btns.forEach((b) => b.classList.toggle('on', b === btn(o)));
      place();
      onChange(o.value);
    },
  }, o.icon ? icon(o.icon, 14) : null, o.label || null));
  const btn = (o) => btns[options.indexOf(o)];
  const el = h('div.seg', ind, btns);
  const place = () => {
    const on = btns.find((b) => b.classList.contains('on'));
    if (!on) return;
    ind.style.left = `${on.offsetLeft}px`;
    ind.style.width = `${on.offsetWidth}px`;
  };
  requestAnimationFrame(place);
  new ResizeObserver(place).observe(el);
  el.set = (v) => {
    btns.forEach((b, i) => b.classList.toggle('on', String(options[i].value) === String(v)));
    place();
  };
  return el;
}

// Tab strip; returns { el, select(name) }.
export function tabStrip(items, onSelect, initial) {
  const ind = h('span.tab-ind');
  const btns = items.map((it) => h('button.tab', { onClick: () => sel(it.id) }, it.icon ? icon(it.icon, 15) : null, it.label));
  const el = h('div.tabs', btns, ind);
  const sel = (id) => {
    btns.forEach((b, i) => b.classList.toggle('on', items[i].id === id));
    const on = btns[items.findIndex((i) => i.id === id)];
    if (on) {
      ind.style.left = `${on.offsetLeft}px`;
      ind.style.width = `${on.offsetWidth}px`;
    }
    onSelect(id);
  };
  requestAnimationFrame(() => sel(initial || items[0].id));
  return { el, select: sel };
}

export function section(title) {
  return h('div.section-title', title);
}

export function note(text, type = '') {
  return h(`div.note${type ? `.${type}` : ''}`, icon(type === 'warn' ? 'warning' : 'info', 15), h('div', text));
}

export { clear };
