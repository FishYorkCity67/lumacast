// Audio mixer: stereo peak meters with hold, faders, mute and per-channel
// settings (device, noise suppression, gate, compressor, monitoring).
import { h, clear, uid } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { state, bus, commit } from '../state.js';
import { app, registerPanel } from '../ctx.js';
import { openModal, field, toggle, select, rangeInput, textInput, note, confirmDialog } from './common.js';

const DB_MIN = -60;
const pos = (db) => Math.max(0, Math.min(1, (db - DB_MIN) / -DB_MIN));

export function mountMixer(el) {
  let rows = [];
  let wrap;

  function channels() {
    const list = state.audioInputs.map((cfg) => ({ id: cfg.id, cfg, kind: cfg.kind, input: true }));
    for (const src of Object.values(state.sources)) {
      if (src.type === 'media' && src.settings.file) list.push({ id: src.id, cfg: { name: src.name, volume: src.settings.volume ?? 1, muted: !!src.settings.muted, monitor: !!src.settings.monitor, enabled: true }, kind: 'media', src });
    }
    return list;
  }

  function render() {
    clear(el);
    wrap = h('div.mixer');
    el.append(
      h('div.card-head',
        h('div.card-title', t('Audio mixer')),
        h('div.card-actions', h('button.icon-btn', { title: t('Add microphone / input'), onClick: addInput }, icon('plus', 16)))),
      wrap,
    );
    rows = channels().map((ch, i) => channelRow(ch, i));
    wrap.append(...rows.map((r) => r.el));
  }

  function save(ch) {
    if (ch.input) {
      commit('audio');
      app.audio.setInput(ch.cfg);
    } else {
      Object.assign(ch.src.settings, { volume: ch.cfg.volume, muted: ch.cfg.muted, monitor: ch.cfg.monitor });
      commit('sources');
    }
  }

  function channelRow(ch, i) {
    const cfg = ch.cfg;
    const ic = ch.kind === 'desktop' ? 'speaker' : ch.kind === 'media' ? 'film' : 'mic';
    const bars = [0, 1].map(() => {
      const fill = h('div.fill');
      const peak = h('div.peak');
      return { el: h('div.bar', fill, peak, h('div.ticks')), fill, peak, v: 0, p: 0, hold: 0 };
    });
    const db = h('span.ch-db', '-∞');
    const muteBtn = h(`button.icon-btn${cfg.muted ? '.danger' : ''}`, {
      title: cfg.muted ? t('Unmute') : t('Mute'),
      onClick: () => {
        cfg.muted = !cfg.muted;
        save(ch);
        render();
      },
    }, icon(cfg.muted ? (ch.kind === 'mic' ? 'micOff' : 'speakerOff') : ic, 16));
    const fader = rangeInput(Math.round((cfg.volume ?? 1) * 100), (v) => {
      cfg.volume = v / 100;
      if (ch.input) app.audio.setInput(cfg);
      else app.audio.updateChannel(ch.id, cfg);
      clearTimeout(fader.t);
      fader.t = setTimeout(() => save(ch), 300);
    }, { min: 0, max: 150, fmt: (v) => `${v}%` });
    const audioCh = app.audio.channels.get(ch.id);
    const err = cfg.enabled === false ? t('Disabled') : audioCh && audioCh.error ? audioCh.error : '';
    const row = h(`div.channel${cfg.muted ? '.muted' : ''}`, { style: { '--i': i } },
      h('span', { style: { color: ch.kind === 'desktop' ? '#8be9ff' : ch.kind === 'mic' ? '#c4b5fd' : '#fcd34d' } }, icon(ic, 16)),
      h('span.ch-name', { title: cfg.name }, cfg.name),
      h('div.row-gap', { style: { gap: '2px' } }, db,
        ch.input ? h('button.icon-btn', { title: t('Channel settings'), onClick: () => settings(ch) }, icon('settings', 15)) : null,
        h(`button.icon-btn${cfg.monitor ? '.on' : ''}`, { title: t('Monitor (hear it in your headphones)'), onClick: () => { cfg.monitor = !cfg.monitor; save(ch); render(); } }, icon('headphones', 15))),
      h('div.meter', bars.map((b) => b.el)),
      h('div.fader-row', muteBtn, fader),
      err ? h('div.err', err) : null);
    return { el: row, ch, bars, db };
  }

  // meters (UI only, rAF)
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const r of rows) {
      if (!r.el.isConnected) continue;
      const lv = app.audio.levels(r.ch.id);
      let maxDb = -100;
      r.bars.forEach((b, i) => {
        const target = pos(lv[i]);
        b.v = target > b.v ? target : Math.max(target, b.v - dt * 1.6);
        if (b.v >= b.p) { b.p = b.v; b.hold = 1; } else if ((b.hold -= dt) <= 0) b.p = Math.max(b.v, b.p - dt * 0.8);
        b.fill.style.clipPath = `inset(0 ${(1 - b.v) * 100}% 0 0)`;
        b.peak.style.left = `calc(${b.p * 100}% - 2px)`;
        b.peak.style.opacity = b.p > 0.01 ? 0.85 : 0;
        maxDb = Math.max(maxDb, lv[i]);
      });
      const txt = maxDb <= -90 ? '-∞' : `${maxDb.toFixed(0)} dB`;
      if (r.db.textContent !== txt) r.db.textContent = txt;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  async function deviceOptions() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    return mics.map((d) => ({ value: d.deviceId, label: d.label || t('Microphone') }));
  }

  async function settings(ch) {
    const cfg = ch.cfg;
    const apply = () => { commit('audio'); app.audio.setInput(cfg); };
    const body = h('div');
    body.append(field(t('Name'), textInput(cfg.name, (v) => { cfg.name = v; apply(); render(); })));
    body.append(field(t('Enabled'), toggle(cfg.enabled !== false, (v) => { cfg.enabled = v; apply(); render(); })));
    if (cfg.kind === 'mic') {
      const opts = await deviceOptions();
      body.append(field(t('Device'), select(cfg.deviceId || 'default', opts.length ? opts : [{ value: 'default', label: t('Default') }], (v) => { cfg.deviceId = v; apply(); })));
      body.append(field(t('Noise suppression'), toggle(cfg.noiseSuppression, (v) => { cfg.noiseSuppression = v; apply(); }), t('Removes fans, keyboards and background hum.')));
    }
    cfg.gate = cfg.gate || { enabled: false, threshold: -48 };
    body.append(field(t('Noise gate'), toggle(cfg.gate.enabled, (v) => { cfg.gate.enabled = v; apply(); })));
    body.append(field(t('Gate threshold'), rangeInput(cfg.gate.threshold, (v) => { cfg.gate.threshold = v; apply(); }, { min: -80, max: -10, fmt: (v) => `${v} dB` })));
    body.append(field(t('Voice compressor'), toggle(cfg.compressor, (v) => { cfg.compressor = v; apply(); }), t('Evens out loud and quiet speech.')));
    if (cfg.kind === 'desktop') body.append(note(t('Desktop Audio captures everything your PC plays. Monitoring other channels would be captured twice — use headphones.'), 'warn'));
    const left = cfg.kind === 'mic' && cfg.id !== 'mic' ? [h('button.btn.btn-danger', { onClick: async () => {
      if (!(await confirmDialog(t('Remove input?'), cfg.name, { ok: t('Remove'), danger: true }))) return;
      state.audioInputs = state.audioInputs.filter((x) => x !== cfg);
      app.audio.remove(cfg.id);
      commit('audio');
      m.close();
      render();
    } }, icon('trash', 14), t('Remove'))] : [];
    const m = openModal({ title: cfg.name, sub: t('Audio channel'), body, left, actions: [h('button.btn.btn-primary', { onClick: () => m.close() }, t('Done'))], width: 520 });
  }

  async function addInput() {
    const opts = await deviceOptions();
    const cfg = { id: uid('aud'), kind: 'mic', name: `${t('Microphone')} ${state.audioInputs.filter((a) => a.kind === 'mic').length + 1}`, deviceId: opts[0] ? opts[0].value : 'default', enabled: true, volume: 1, muted: false, monitor: false, noiseSuppression: true, gate: { enabled: true, threshold: -48 }, compressor: true };
    state.audioInputs.push(cfg);
    commit('audio');
    await app.audio.setInput(cfg);
    render();
    settings({ id: cfg.id, cfg, kind: 'mic', input: true });
  }

  bus.on('sources', () => {
    const sig = channels().map((c) => c.id).join();
    if (sig !== el.dataset.sig) {
      el.dataset.sig = sig;
      render();
    }
  });
  bus.on('audio-ui', render);
  render();
  return registerPanel({ render });
}
