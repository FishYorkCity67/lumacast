// Scenes panel: animated active highlight, inline rename, drag to reorder.
import { h, clear } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { state, bus, commit, addScene, duplicateScene, removeScene, getScene } from '../state.js';
import { app, registerPanel } from '../ctx.js';
import { contextMenu, confirmDialog, toast } from './common.js';

const COLORS = ['#7c5cff', '#22d3ee', '#ff3d71', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#60a5fa'];

export function mountScenes(el) {
  let list;
  let glow;
  let dragId = null;

  function render() {
    clear(el);
    list = h('div.list');
    glow = h('div.list-glow');
    list.append(glow);
    el.append(
      h('div.card-head',
        h('div.card-title', t('Scenes'), h('span.count', String(state.scenes.length))),
        h('div.card-actions', h('button.icon-btn', { title: t('Add scene'), onClick: add }, icon('plus', 16)))),
      h('div.card-body', list),
    );
    state.scenes.forEach((s, i) => list.append(row(s, i)));
    placeGlow(true);
  }

  function row(scene, i) {
    const r = h(`div.row${scene.id === state.activeSceneId ? '.active' : ''}`, {
      style: { '--i': i },
      draggable: true,
      dataset: { id: scene.id },
      onClick: () => app.compositor.switchTo(scene.id),
      onDblclick: () => rename(scene, r),
      onContextmenu: (e) => { e.preventDefault(); menu(scene, e.clientX, e.clientY, r); },
    },
    h('span.scene-dot', { style: { background: scene.color, color: scene.color } }),
    h('span.label', scene.name),
    i < 9 ? h('span.hotkey-chip', { title: t('Ctrl+{n} switches to this scene', { n: i + 1 }) }, `^${i + 1}`) : null,
    h('div.row-actions', h('button.icon-btn', { onClick: (e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); menu(scene, b.left, b.bottom + 4, r); } }, icon('more', 15))));
    r.addEventListener('dragstart', (e) => { dragId = scene.id; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    r.addEventListener('dragend', () => { dragId = null; r.classList.remove('dragging'); clearDrop(); });
    r.addEventListener('dragover', (e) => {
      if (!dragId || dragId === scene.id) return;
      e.preventDefault();
      clearDrop();
      const b = r.getBoundingClientRect();
      r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-before' : 'drop-after');
    });
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = r.classList.contains('drop-before');
      clearDrop();
      if (!dragId || dragId === scene.id) return;
      const moving = getScene(dragId);
      state.scenes = state.scenes.filter((s) => s !== moving);
      const idx = state.scenes.indexOf(scene) + (before ? 0 : 1);
      state.scenes.splice(idx, 0, moving);
      commit('scenes');
    });
    return r;
  }

  const clearDrop = () => list.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));

  function placeGlow(instant) {
    const active = list && list.querySelector(`.row[data-id="${state.activeSceneId}"]`);
    if (!active) {
      glow.style.opacity = 0;
      return;
    }
    if (instant) glow.style.transition = 'none';
    glow.style.opacity = 1;
    glow.style.transform = `translateY(${active.offsetTop}px)`;
    if (instant) requestAnimationFrame(() => { glow.style.transition = ''; });
  }

  function select() {
    list.querySelectorAll('.row').forEach((r) => r.classList.toggle('active', r.dataset.id === state.activeSceneId));
    placeGlow(false);
  }

  function add() {
    const scene = addScene(`${t('Scene')} ${state.scenes.length + 1}`, COLORS[state.scenes.length % COLORS.length]);
    commit('scenes');
    app.compositor.switchTo(scene.id);
    setTimeout(() => {
      const r = list.querySelector(`.row[data-id="${scene.id}"]`);
      if (r) rename(scene, r);
    }, 50);
  }

  function rename(scene, r) {
    const label = r.querySelector('.label');
    const input = h('input.rename-input', { value: scene.name });
    label.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (save && input.value.trim()) {
        scene.name = input.value.trim();
        commit('scenes');
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  function menu(scene, x, y, r) {
    const idx = state.scenes.indexOf(scene);
    contextMenu(x, y, [
      { label: t('Rename'), icon: 'pencil', onClick: () => rename(scene, r) },
      { label: t('Duplicate'), icon: 'copy', onClick: () => { duplicateScene(scene.id, `${scene.name} (${t('copy')})`); commit('scenes'); } },
      { label: t('Change color'), icon: 'palette', onClick: () => { scene.color = COLORS[(COLORS.indexOf(scene.color) + 1) % COLORS.length]; commit('scenes'); } },
      '-',
      { label: t('Move up'), icon: 'up', disabled: idx === 0, onClick: () => { state.scenes.splice(idx, 1); state.scenes.splice(idx - 1, 0, scene); commit('scenes'); } },
      { label: t('Move down'), icon: 'down', disabled: idx === state.scenes.length - 1, onClick: () => { state.scenes.splice(idx, 1); state.scenes.splice(idx + 1, 0, scene); commit('scenes'); } },
      '-',
      { label: t('Delete scene'), icon: 'trash', danger: true, disabled: state.scenes.length <= 1, onClick: async () => {
        if (await confirmDialog(t('Delete scene?'), t('"{name}" and its sources will be removed.', { name: scene.name }), { ok: t('Delete'), danger: true })) {
          removeScene(scene.id);
          commit('scenes');
          commit('activeScene');
          toast(t('Scene deleted'), { type: 'ok' });
        }
      } },
    ]);
  }

  bus.on('scenes', render);
  bus.on('activeScene', select);
  render();
  return registerPanel({ render });
}
