// Sources of the active scene (front-most first), with visibility/lock toggles,
// selection synced to the preview editor, and drag to reorder.
import { h, clear } from '../util.js';
import { icon, SOURCE_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, bus, commit, activeScene } from '../state.js';
import { app, registerPanel } from '../ctx.js';
import { itemMenu } from './items.js';

export function mountSources(el) {
  let list;
  let dragId = null;

  function render() {
    clear(el);
    const scene = activeScene();
    list = h('div.list');
    el.append(
      h('div.card-head',
        h('div.card-title', t('Sources'), h('span.count', scene ? String(scene.items.length) : '0')),
        h('div.card-actions', h('button.btn.btn-sm.btn-primary', { onClick: () => app.actions.openAddSource() }, icon('plus', 14), t('Add')))),
      h('div.card-body', list),
    );
    if (!scene || !scene.items.length) {
      list.append(h('div.empty', icon('layout', 22), h('div', t('This scene is empty.')), h('div', t('Add your screen, a camera, text or widgets.'))));
      return;
    }
    [...scene.items].reverse().forEach((item, i) => list.append(row(scene, item, i)));
  }

  function row(scene, item, i) {
    const src = state.sources[item.sourceId];
    if (!src) return null;
    const r = app.mgr.get(item.sourceId);
    const hiddenHere = item[rt.editCanvas] && item[rt.editCanvas].show === false;
    const el2 = h(`div.row${rt.selection === item.id ? '.active' : ''}${!item.visible || hiddenHere ? '.hidden-item' : ''}`, {
      style: { '--i': i, background: rt.selection === item.id ? 'rgba(124,92,255,.14)' : '' },
      draggable: true,
      dataset: { id: item.id },
      title: r && r.error ? t(r.error) : '',
      onClick: () => { rt.selection = item.id; bus.emit('selection'); },
      onDblclick: () => app.actions.openProperties(item.id),
      onContextmenu: (e) => { e.preventDefault(); rt.selection = item.id; bus.emit('selection'); itemMenu(scene, item, e.clientX, e.clientY); },
    },
    icon(SOURCE_ICONS[src.type] || 'layout', 15, 'type'),
    h('span.label', src.name),
    r && r.error ? h('span', { title: t(r.error), style: { color: 'var(--warn)' } }, icon('warning', 14)) : null,
    hiddenHere ? h('span.meta', rt.editCanvas === 'v' ? '9:16 âœ•' : '16:9 âœ•') : null,
    h('div.row-actions',
      h(`button.icon-btn${item.locked ? '.on' : ''}`, { title: item.locked ? t('Unlock') : t('Lock'), onClick: (e) => { e.stopPropagation(); item.locked = !item.locked; commit('items'); } }, icon(item.locked ? 'lock' : 'unlock', 14)),
      h('button.icon-btn', { title: item.visible ? t('Hide') : t('Show'), onClick: (e) => { e.stopPropagation(); item.visible = !item.visible; commit('items'); } }, icon(item.visible ? 'eye' : 'eyeOff', 15))));
    el2.addEventListener('dragstart', (e) => { dragId = item.id; el2.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    el2.addEventListener('dragend', () => { dragId = null; el2.classList.remove('dragging'); clearDrop(); });
    el2.addEventListener('dragover', (e) => {
      if (!dragId || dragId === item.id) return;
      e.preventDefault();
      clearDrop();
      const b = el2.getBoundingClientRect();
      el2.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-before' : 'drop-after');
    });
    el2.addEventListener('drop', (e) => {
      e.preventDefault();
      const above = el2.classList.contains('drop-before');
      clearDrop();
      if (!dragId || dragId === item.id) return;
      const moving = scene.items.find((x) => x.id === dragId);
      scene.items = scene.items.filter((x) => x !== moving);
      // list is shown front-most first, so "above" in the list = later in draw order
      const idx = scene.items.indexOf(item) + (above ? 1 : 0);
      scene.items.splice(idx, 0, moving);
      commit('items');
    });
    return el2;
  }

  const clearDrop = () => list.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));

  for (const ev of ['activeScene', 'items', 'sources', 'selection', 'editCanvas']) bus.on(ev, render);
  setInterval(() => {
    // refresh warning icons when sources fail or recover
    const scene = activeScene();
    if (!scene) return;
    const sig = scene.items.map((i) => (app.mgr.get(i.sourceId) || {}).error || '').join('|');
    if (sig !== el.dataset.sig) {
      el.dataset.sig = sig;
      render();
    }
  }, 2000);
  render();
  return registerPanel({ render });
}
