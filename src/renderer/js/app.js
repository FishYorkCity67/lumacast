// Bootstrap: load state, start the audio/compositor/output engines, mount the
// panels and wire events, hotkeys and high-level actions together.
import { $, fmtDuration } from './util.js';
import { t, setLang, getLang } from './i18n.js';
import { state, rt, bus, loadState, commit, createDefaultStudio, activeScene, flushSave } from './state.js';
import { app, rerenderAll } from './ctx.js';
import { AudioEngine } from './audio.js';
import { ChatHub } from './chat.js';
import { SourceManager } from './sources.js';
import { Compositor } from './compositor.js';
import { OutputController } from './output.js';
import { Automation } from './automation.js';
import { mountTopbar, mountStatusbar } from './ui/bars.js';
import { mountScenes } from './ui/scenes.js';
import { mountSources } from './ui/sourcesPanel.js';
import { mountStage } from './ui/stage.js';
import { mountMixer } from './ui/mixer.js';
import { mountControls, countdown } from './ui/controls.js';
import { mountDestinations, editDestination } from './ui/destinations.js';
import { mountChat } from './ui/chatPanel.js';
import { openAddSource, openProperties } from './ui/properties.js';
import { openSettings } from './ui/settings.js';
import { showRecap, showWelcome } from './ui/recap.js';
import { toast, confirmDialog } from './ui/common.js';

const fileName = (f) => f.split(/[\\/]/).pop();
let liveBusy = false;
let replayAuto = false;
let lastBitrateToast = 0;

function alertFor(ev) {
  const n = ev.amount;
  const titles = {
    sub: n > 1 ? t('subscribed for {n} months!', { n }) : t('just subscribed!'),
    gift: n > 1 ? t('gifted {n} subs!', { n }) : ev.message ? t('gifted a sub to {name}!', { name: ev.message }) : t('gifted a sub!'),
    raid: t('is raiding with {n} viewers!', { n }),
    cheer: t('cheered {n} bits!', { n }),
    superchat: t('sent a Super Chat · {amount}', { amount: n }),
    member: t('became a member!'),
  };
  return { type: ev.type, user: ev.user, title: titles[ev.type] || '', message: ev.type === 'gift' ? '' : ev.message || '' };
}

const actions = {
  setLanguage(l) {
    setLang(l);
    state.settings.language = l;
    commit('settings');
    rerenderAll();
  },
  openSettings: (tab) => openSettings(tab),
  openAddSource: () => openAddSource(),
  openProperties: (id) => openProperties(id),
  openChatSettings: () => app.chatPanel.settings(),
  editDestination: (d) => editDestination(d),

  setVertical(on) {
    if (rt.engine) {
      toast(t('Stop streaming, recording and the replay buffer to change canvases.'), { type: 'warn' });
      return;
    }
    state.settings.video.v.enabled = on;
    if (!on && rt.editCanvas === 'v') rt.editCanvas = 'h';
    commit('settings');
    actions.videoChanged();
  },

  setResolution(key, w, hh) {
    const cur = state.settings.video[key];
    const sx = w / cur.width;
    const sy = hh / cur.height;
    for (const sc of state.scenes) {
      for (const it of sc.items) {
        const L = it[key];
        if (!L) continue;
        L.x = Math.round(L.x * sx);
        L.y = Math.round(L.y * sy);
        L.w = Math.round(L.w * sx);
        L.h = Math.round(L.h * sy);
      }
    }
    cur.width = w;
    cur.height = hh;
    commit('settings');
    commit('items');
    actions.videoChanged();
  },

  videoChanged() {
    app.compositor.applySize('h');
    app.compositor.applySize('v');
    app.compositor.restartTicker();
    bus.emit('video');
  },

  async toggleLive() {
    if (liveBusy) return;
    if (rt.live) await actions.endLive();
    else await actions.goLive();
  },

  async goLive() {
    const dests = state.destinations.filter((d) => d.enabled);
    if (!rt.info.ffmpeg) {
      toast(t('FFmpeg not found'), { type: 'err', text: t('Install it with "winget install Gyan.FFmpeg", then restart Lumacast.') });
      return;
    }
    if (!dests.length) {
      toast(t('Add a destination first'), { type: 'warn' });
      editDestination(null);
      return;
    }
    const missing = dests.find((d) => !d.server || (!d.key && d.platform !== 'custom'));
    if (missing) {
      toast(t('{name}: stream key missing', { name: missing.name }), { type: 'warn' });
      editDestination(missing);
      return;
    }
    if (state.settings.countdown > 0 && !(await countdown(state.settings.countdown))) return;
    liveBusy = true;
    app.controls.setBusy(true);
    try {
      app.chat.resetSession();
      rt.markers = [];
      rt.clips = [];
      await app.output.goLive(dests);
      if (state.settings.replay.autoStart && !rt.replay) {
        await app.output.setReplay(true);
        replayAuto = true;
      }
      document.body.querySelector('#app').classList.add('is-live');
      toast(t("You're live!"), { type: 'ok', text: dests.map((d) => d.name).join(' · ') });
    } catch (err) {
      toast(t('Could not go live'), { type: 'err', text: String(err.message || err) });
      await app.output.endLive().catch(() => {});
    } finally {
      liveBusy = false;
      app.controls.setBusy(false);
      bus.emit('runtime');
    }
  },

  async endLive(skipConfirm) {
    if (!skipConfirm && state.settings.confirmEnd && !(await confirmDialog(t('End stream?'), t('You will go offline on all destinations.'), { ok: t('End stream'), danger: true }))) return;
    liveBusy = true;
    app.controls.setBusy(true);
    const duration = Date.now() - rt.liveStart;
    const outputs = ((rt.stats && rt.stats.outputs) || []).filter((o) => o.kind === 'rtmp');
    try {
      if (replayAuto) {
        replayAuto = false;
        await app.output.setReplay(false);
      }
      await app.output.endLive();
    } finally {
      liveBusy = false;
      app.controls.setBusy(false);
      document.body.querySelector('#app').classList.remove('is-live');
      bus.emit('runtime');
    }
    let markersFile = null;
    if (rt.markers.length) {
      markersFile = await window.lc.invoke('markers:save', { folder: state.settings.recording.folder || rt.info.videosDir, text: actions.markersText() });
    }
    if (!skipConfirm) showRecap({ duration, outputs, session: app.chat.session, markers: rt.markers.slice(), clips: rt.clips.slice(), markersFile });
  },

  markersText() {
    return app.automation.markersText(t('Lumacast stream markers'));
  },

  async toggleRecord() {
    if (!rt.info.ffmpeg) {
      toast(t('FFmpeg not found'), { type: 'err' });
      return;
    }
    try {
      if (rt.recording) {
        const files = await app.output.stopRecording();
        toast(t('Recording saved'), { type: 'ok', text: files.map(fileName).join(', '), actions: files.length ? [{ label: t('Show'), onClick: () => window.lc.invoke('shell:reveal', files[0]) }] : [] });
      } else {
        await app.output.startRecording();
        toast(t('Recording started'), { type: 'ok', duration: 2500 });
      }
    } catch (err) {
      toast(t('Recording failed'), { type: 'err', text: String(err.message || err) });
    }
    bus.emit('runtime');
  },

  async toggleReplay() {
    try {
      replayAuto = false;
      await app.output.setReplay(!rt.replay);
      toast(rt.replay ? t('Replay buffer on — press Clip to save the last {n}s', { n: state.settings.replay.seconds }) : t('Replay buffer off'), { type: 'info', duration: 3000 });
    } catch (err) {
      toast(t('Replay buffer failed'), { type: 'err', text: String(err.message || err) });
    }
    bus.emit('runtime');
  },

  async saveClip(label) {
    if (!rt.replay) {
      toast(t('Turn on the replay buffer first'), { type: 'warn' });
      return;
    }
    const files = await app.output.saveClip(label);
    if (!files || !files.length) {
      toast(t('Nothing to clip yet'), { type: 'warn', text: t('The replay buffer needs a few seconds of video.') });
      return;
    }
    if (rt.live) app.automation.addMarker(label ? `${t('Clip')}: ${label}` : t('Clip'));
    toast(label ? t('Hype clip saved!') : t('Clip saved'), {
      type: 'ok', text: files.map(fileName).join('\n'),
      actions: [{ label: t('Show'), onClick: () => window.lc.invoke('shell:reveal', files[0]) }],
    });
  },

  addMarker(label) {
    const m = app.automation.addMarker(label);
    if (m) toast(t('Marker at {t}', { t: fmtDuration(m.t) }), { type: 'ok', duration: 2500 });
    else toast(t('Markers work while live or recording'), { type: 'info' });
  },

  togglePrivacy() {
    app.automation.togglePrivacy();
  },

  toggleMuteMic() {
    const mic = state.audioInputs.find((a) => a.kind === 'mic');
    if (!mic) return;
    mic.muted = !mic.muted;
    commit('audio');
    app.audio.setInput(mic);
    bus.emit('audio-ui');
    toast(mic.muted ? t('Microphone muted') : t('Microphone live'), { type: mic.muted ? 'warn' : 'ok', duration: 2000 });
  },

  testAlert(kind) {
    const amount = { raid: 42, cheer: 500, superchat: '€5.00', gift: 5, sub: 12 }[kind] || 1;
    app.mgr.emit('alert', alertFor({ type: kind, user: 'Lumacast', amount, message: kind === 'gift' ? '' : t('This is a test alert') }));
  },
};

function wireEvents() {
  bus.on('sources', () => app.mgr.sync());

  window.lc.on('stats', (s) => {
    rt.stats = s;
    bus.emit('stats');
  });

  window.lc.on('outputs:status', ({ id, status, error }) => {
    const prev = (rt.outputs[id] || {}).status;
    rt.outputs[id] = { status, error };
    bus.emit('outputs');
    const d = state.destinations.find((x) => x.id === id);
    const name = d ? d.name : id;
    if (!rt.live || prev === status) return;
    if (status === 'live' && prev === 'reconnecting') toast(t('{name} is back', { name }), { type: 'ok', duration: 3000 });
    else if (status === 'reconnecting') toast(t('{name} lost connection — reconnecting', { name }), { type: 'warn', text: error });
    else if (status === 'error') toast(t('{name} failed', { name }), { type: 'err', text: error });
  });

  window.lc.on('record:status', ({ status, error }) => {
    if (status === 'error') toast(t('Recording failed'), { type: 'err', text: error });
  });

  app.output.on('fault', (msg) => toast(t('Encoder problem'), { type: 'err', text: msg }));
  app.output.on('bitrate', (canvas, kbps, target) => {
    if (kbps < target && Date.now() - lastBitrateToast > 60000) {
      lastBitrateToast = Date.now();
      toast(t('Network congested'), { type: 'warn', text: t('Adaptive bitrate lowered {c} to {k} kbps. It recovers automatically.', { c: canvas === 'v' ? '9:16' : '16:9', k: Math.round(kbps) }) });
    }
  });

  app.chat.on('event', (ev) => app.mgr.emit('alert', alertFor(ev)));
  app.chat.on('hype', () => {
    if (!rt.live) return;
    if (rt.replay) actions.saveClip(t('Hype'));
    else app.automation.addMarker(t('Chat hype'));
  });

  app.mgr.on('timer-ended', (srcId, sceneId) => {
    const scene = activeScene();
    if (sceneId && scene && scene.items.some((i) => i.sourceId === srcId)) app.compositor.switchTo(sceneId);
  });

  app.audio.on('channel-ended', (id) => {
    const cfg = state.audioInputs.find((a) => a.id === id);
    if (cfg) setTimeout(() => app.audio.setInput(cfg).then(() => bus.emit('audio-ui')), 1500);
    bus.emit('audio-ui');
  });
  app.audio.on('channel-error', (id, err) => {
    bus.emit('audio-ui');
    const cfg = state.audioInputs.find((a) => a.id === id);
    toast(t('{name} unavailable', { name: cfg ? cfg.name : id }), { type: 'warn', text: err });
  });
  navigator.mediaDevices.addEventListener('devicechange', () => bus.emit('audio-ui'));

  app.automation.on('privacy', (p) => {
    bus.emit('runtime');
    if (p.active && p.reason !== 'manual') toast(t('Privacy Shield on'), { type: 'info', text: t('Your screen is blurred on stream while {r} is focused.', { r: p.reason }), duration: 3000 });
  });
  app.automation.on('rule', (r) => {
    const sc = state.scenes.find((s) => s.id === r.scene);
    toast(t('Auto-switched to {s}', { s: sc ? sc.name : '' }), { type: 'info', duration: 2500 });
  });

  window.lc.on('hotkey', (action) => {
    const map = {
      goLive: actions.toggleLive, record: actions.toggleRecord, clip: () => actions.saveClip(),
      marker: () => actions.addMarker(), privacy: actions.togglePrivacy, muteMic: actions.toggleMuteMic,
    };
    if (map[action]) map[action]();
  });

  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const scene = state.scenes[Number(e.code.slice(5)) - 1];
    if (scene) {
      e.preventDefault();
      app.compositor.switchTo(scene.id);
    }
  });

  window.lc.on('app:confirm-close', async () => {
    const what = rt.live ? t('You are live.') : rt.recording ? t('You are recording.') : t('The replay buffer is running.');
    if (!(await confirmDialog(t('Quit Lumacast?'), `${what} ${t('Everything will be stopped and saved first.')}`, { ok: t('Stop & quit'), danger: true }))) return;
    try {
      if (rt.live) await actions.endLive(true);
      if (rt.recording) await app.output.stopRecording();
      if (rt.replay) await app.output.setReplay(false);
    } finally {
      flushSave();
      window.lc.invoke('app:quit');
    }
  });

  window.addEventListener('beforeunload', () => flushSave());
}

async function boot() {
  rt.info = await window.lc.invoke('app:info');
  const data = await window.lc.invoke('state:load');
  loadState(data);
  if (!data) state.settings.language = /^de/i.test(rt.info.locale || '') ? 'de' : 'en';
  setLang(state.settings.language || 'en');
  state.settings.language = getLang();

  app.audio = new AudioEngine();
  await app.audio.init();
  app.chat = new ChatHub();
  app.mgr = new SourceManager(app.audio, app.chat);
  app.compositor = new Compositor(app.mgr);
  app.output = new OutputController(app.compositor, app.audio);
  app.automation = new Automation(app.compositor, app.audio);
  app.actions = actions;

  if (!state.scenes.length) {
    createDefaultStudio(t);
    for (const a of state.audioInputs) a.name = t(a.kind === 'desktop' ? 'Desktop Audio' : 'Microphone');
  }
  app.mgr.sync();
  await Promise.all(state.audioInputs.map((cfg) => app.audio.setInput(cfg).catch(() => {})));

  mountTopbar($('#topbar'));
  mountScenes($('#scenes-panel'));
  mountSources($('#sources-panel'));
  mountStage($('#stage-panel'));
  mountMixer($('#mixer-panel'));
  app.controls = mountControls($('#controls-panel'));
  mountDestinations($('#dest-panel'));
  app.chatPanel = mountChat($('#chat-panel'));
  mountStatusbar($('#statusbar'));
  app.compositor.start();
  wireEvents();
  commit('scenes');

  requestAnimationFrame(() => $('#app').classList.add('ready'));
  app.chat.connect();
  app.automation.apply();
  window.lc.invoke('hotkeys:set', state.settings.hotkeys);

  if (!state.settings.onboarded) {
    state.settings.onboarded = true;
    commit('settings');
    setTimeout(() => showWelcome(() => editDestination(null)), 700);
  }
  if (!rt.info.ffmpeg) {
    toast(t('FFmpeg not found'), { type: 'err', duration: 0, text: t('Install it with "winget install Gyan.FFmpeg", then restart Lumacast.') });
  }
  if (rt.info.dev) window.__lc = { app, state, rt, bus, commit, actions };
}

boot().catch((err) => {
  console.error(err);
  document.body.append(Object.assign(document.createElement('pre'), {
    textContent: `Lumacast failed to start:\n${err && err.stack ? err.stack : err}`,
    style: 'position:fixed;inset:20px;color:#ff9aae;white-space:pre-wrap;font:13px Consolas,monospace;z-index:999',
  }));
  window.lc.invoke('log', 'renderer', String(err && err.stack ? err.stack : err));
});
