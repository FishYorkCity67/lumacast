// Item operations shared by the sources panel and the preview editor.
import { uid, deepClone } from '../util.js';
import { t } from '../i18n.js';
import { state, rt, commit, getScene, removeItem, autoLayout, containRect, coverRegion, canvasSize, verticalEnabled } from '../state.js';
import { app } from '../ctx.js';
import { contextMenu, toast } from './common.js';

export function naturalOf(item) {
  const r = app.mgr.get(item.sourceId);
  return r ? r.natural() : null;
}

export function transform(item, key, mode) {
  const L = item[key];
  const { w: W, h: H } = canvasSize(key);
  const src = state.sources[item.sourceId];
  const nat = naturalOf(item);
  const crop = L.crop || { l: 0, t: 0, r: 0, b: 0 };
  const nw = nat ? nat.w - crop.l - crop.r : L.w;
  const nh = nat ? nat.h - crop.t - crop.b : L.h;
  if (mode === 'fit') Object.assign(L, containRect(nw, nh, W, H));
  else if (mode === 'stretch') Object.assign(L, { x: 0, y: 0, w: W, h: H });
  else if (mode === 'cover' && nat) Object.assign(L, coverRegion(nat.w, nat.h, 0, 0, W, H));
  else if (mode === 'center') Object.assign(L, { x: (W - L.w) / 2, y: (H - L.h) / 2 });
  else if (mode === 'reset') item[key] = { ...autoLayout(src.type, nat, key), show: L.show !== false };
  else if (mode === 'natural' && nat) Object.assign(L, { w: nw, h: nh, x: (W - nw) / 2, y: (H - nh) / 2 });
  for (const k of ['x', 'y', 'w', 'h']) item[key][k] = Math.round(item[key][k]);
  commit('items');
}

export function moveItem(scene, item, where) {
  const arr = scene.items;
  const i = arr.indexOf(item);
  arr.splice(i, 1);
  if (where === 'top') arr.push(item);
  else if (where === 'bottom') arr.unshift(item);
  else if (where === 'up') arr.splice(Math.min(arr.length, i + 1), 0, item);
  else arr.splice(Math.max(0, i - 1), 0, item);
  commit('items');
}

export function duplicateItem(scene, item) {
  const src = state.sources[item.sourceId];
  const copy = { ...deepClone(src), id: uid('src'), name: `${src.name} 2` };
  state.sources[copy.id] = copy;
  const it = { ...deepClone(item), id: uid('item'), sourceId: copy.id };
  for (const k of ['h', 'v']) {
    it[k].x += 30;
    it[k].y += 30;
  }
  scene.items.splice(scene.items.indexOf(item) + 1, 0, it);
  rt.selection = it.id;
  commit('sources');
  commit('items');
}

export function removeWithUndo(scene, item) {
  const index = scene.items.indexOf(item);
  const srcCopy = deepClone(state.sources[item.sourceId]);
  const itemCopy = deepClone(item);
  removeItem(scene.id, item.id);
  commit('sources');
  commit('items');
  toast(t('Removed "{name}"', { name: srcCopy.name }), {
    type: 'info',
    actions: [{
      label: t('Undo'),
      onClick: () => {
        const sc = getScene(scene.id);
        if (!sc) return;
        if (!state.sources[srcCopy.id]) state.sources[srcCopy.id] = srcCopy;
        sc.items.splice(Math.min(index, sc.items.length), 0, itemCopy);
        commit('sources');
        commit('items');
      },
    }],
  });
}

export function itemMenu(scene, item, x, y) {
  const key = rt.editCanvas;
  const src = state.sources[item.sourceId];
  const L = item[key];
  const other = key === 'h' ? 'v' : 'h';
  const canvasName = (k) => (k === 'v' ? '9:16' : '16:9');
  contextMenu(x, y, [
    { title: src.name },
    { label: t('Properties'), icon: 'settings', k: t('Double-click'), onClick: () => app.actions.openProperties(item.id) },
    { label: item.visible ? t('Hide') : t('Show'), icon: item.visible ? 'eyeOff' : 'eye', onClick: () => { item.visible = !item.visible; commit('items'); } },
    { label: item.locked ? t('Unlock') : t('Lock'), icon: item.locked ? 'unlock' : 'lock', onClick: () => { item.locked = !item.locked; commit('items'); } },
    '-',
    { title: t('Layout on {c}', { c: canvasName(key) }) },
    { label: t('Fit to canvas'), icon: 'fit', onClick: () => transform(item, key, 'fit') },
    { label: t('Fill canvas (crop)'), icon: 'layout', onClick: () => transform(item, key, 'cover') },
    { label: t('Stretch to canvas'), icon: 'fit', onClick: () => transform(item, key, 'stretch') },
    { label: t('Center'), icon: 'center', onClick: () => transform(item, key, 'center') },
    { label: t('Reset layout'), icon: 'refresh', onClick: () => transform(item, key, 'reset') },
    { label: L.show === false ? t('Show on {c}', { c: canvasName(key) }) : t('Hide on {c}', { c: canvasName(key) }), icon: L.show === false ? 'eye' : 'eyeOff', onClick: () => { L.show = L.show === false; commit('items'); } },
    verticalEnabled() ? { label: item[other].show === false ? t('Show on {c}', { c: canvasName(other) }) : t('Hide on {c}', { c: canvasName(other) }), icon: other === 'v' ? 'phone' : 'tv', onClick: () => { item[other].show = item[other].show === false; commit('items'); } } : null,
    '-',
    { label: t('Bring to front'), icon: 'up', onClick: () => moveItem(scene, item, 'top') },
    { label: t('Send to back'), icon: 'down', onClick: () => moveItem(scene, item, 'bottom') },
    { label: t('Duplicate'), icon: 'copy', onClick: () => duplicateItem(scene, item) },
    '-',
    { label: t('Remove'), icon: 'trash', danger: true, k: 'Del', onClick: () => removeWithUndo(scene, item) },
  ]);
}
