// Top bar (brand, active scene, live/rec/replay/shield pills, language,
// settings) and bottom status bar (CPU, FPS, encoder, upload, disk).
import { h, clear, fmtDuration } from '../util.js';
import { icon } from '../icons.js';
import { t, getLang } from '../i18n.js';
import { state, rt, bus, activeScene } from '../state.js';
import { app, registerPanel } from '../ctx.js';

export function mountTopbar(el) {
  let pills;
  let sceneChip;

  function render() {
    clear(el);
    sceneChip = h('div.top-scene');
    pills = h('div.row-gap');
    el.append(
      h('div.brand', h('div.brand-mark'), 'Lumacast', h('small', `v${rt.info ? rt.info.version : ''}`)),
      sceneChip,
      h('div.spacer'),
      pills,
      h('div.lang',
        ['en', 'de'].map((l) => h(`button${getLang() === l ? '.on' : ''}`, { onClick: () => app.actions.setLanguage(l) }, l.toUpperCase()))),
      h('button.btn.btn-sm.btn-ghost', { onClick: () => app.actions.openSettings(), title: t('Settings') }, icon('settings', 16), t('Settings')),
    );
    update(true);
  }

  let lastKey = '';
  function update(force) {
    const scene = activeScene();
    if (sceneChip) {
      clear(sceneChip).append(h('span.dot', { style: { background: scene ? scene.color : '#888' } }), scene ? scene.name : '—');
    }
    const key = [rt.live, rt.recording, rt.replay, rt.privacy.active].join();
    if (force || key !== lastKey) {
      lastKey = key;
      clear(pills);
      if (rt.privacy.active) pills.append(h('span.pill.shield.pill-enter', icon('shieldOn', 14), t('Privacy Shield')));
      if (rt.replay) pills.append(h('span.pill.replay.pill-enter', icon('replay', 14), `${t('Replay')} ${state.settings.replay.seconds}s`));
      if (rt.recording) pills.append(h('span.pill.rec.pill-enter', h('span.dot'), h('span.rec-time', 'REC')));
      if (rt.live) pills.append(h('span.pill.live.pill-enter', h('span.dot'), h('span.live-time', 'LIVE')));
    }
    const lt = pills.querySelector('.live-time');
    if (lt) lt.textContent = `LIVE ${fmtDuration(Date.now() - rt.liveStart)}`;
    const rtm = pills.querySelector('.rec-time');
    if (rtm) rtm.textContent = `REC ${fmtDuration(Date.now() - rt.recStart)}`;
  }

  bus.on('activeScene', () => update());
  bus.on('scenes', () => update());
  bus.on('runtime', () => update());
  setInterval(() => update(), 1000);
  render();
  return registerPanel({ render, update });
}

export function mountStatusbar(el) {
  const items = {};
  function item(key, ic) {
    const v = h('b', '—');
    const node = h('div.item', icon(ic, 13), v);
    items[key] = { node, v };
    return node;
  }

  function render() {
    clear(el);
    el.append(
      item('cpu', 'cpu'), item('fps', 'zap'), item('enc', 'film'), item('up', 'signal'), item('disk', 'hdd'),
      h('div.grow'),
      item('focus', 'shield'),
    );
  }

  function update() {
    const s = rt.stats;
    const c = app.compositor;
    if (!items.cpu) return;
    const cpu = s ? s.cpu : 0;
    items.cpu.v.textContent = `${t('CPU')} ${cpu}%`;
    items.cpu.node.className = `item${cpu > 85 ? ' bad' : cpu > 65 ? ' warn' : ''}`;
    items.fps.v.textContent = `${c.fps} fps · ${c.renderMs.toFixed(1)} ms`;
    const enc = app.output.encoderStats();
    const encKeys = Object.keys(enc);
    if (encKeys.length) {
      const dropped = encKeys.reduce((a, k) => a + enc[k].dropped, 0);
      items.enc.v.textContent = `${t('Encoding')} ${encKeys.map((k) => `${k === 'v' ? '9:16' : '16:9'} ${Math.round(enc[k].kbps)}k`).join(' · ')}${dropped ? ` · ${t('{n} skipped', { n: dropped })}` : ''}`;
      items.enc.node.className = `item${dropped > 30 ? ' warn' : ''}`;
    } else {
      items.enc.v.textContent = t('Encoder idle');
      items.enc.node.className = 'item';
    }
    const outs = s ? s.outputs.filter((o) => o.kind === 'rtmp') : [];
    const up = outs.reduce((a, o) => a + o.kbps, 0);
    items.up.v.textContent = outs.length ? `${t('Upload')} ${(up / 1000).toFixed(1)} Mbit/s` : t('Offline');
    items.disk.v.textContent = s && s.diskGB !== null ? `${s.diskGB} GB ${t('free')}` : '—';
    items.disk.node.className = `item${s && s.diskGB !== null && s.diskGB < 10 ? ' warn' : ''}`;
    const f = rt.focus;
    const watching = state.settings.privacy.enabled;
    items.focus.node.classList.toggle('hidden', !watching);
    if (watching) items.focus.v.textContent = rt.privacy.active ? t('Shield active: {r}', { r: rt.privacy.reason === 'manual' ? t('manual') : rt.privacy.reason }) : `${t('Shield watching')}${f && f.process && !f.own ? ` · ${f.process}` : ''}`;
  }

  render();
  setInterval(update, 1000);
  return registerPanel({ render, update });
}
