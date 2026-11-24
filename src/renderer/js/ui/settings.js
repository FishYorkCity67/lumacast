// Settings modal: General, Video, Audio, Recording & clips, Privacy Shield,
// Automation rules, Hotkeys, About.
import { h, clear, uid } from '../util.js';
import { icon } from '../icons.js';
import { t, getLang } from '../i18n.js';
import { state, rt, commit, DEFAULT_PRIVACY_KEYWORDS } from '../state.js';
import { app } from '../ctx.js';
import {
  openModal, field, textInput, numInput, rangeInput, toggle, select, segmented, section, note, tabStrip, toast,
} from './common.js';

const RES_H = [[1920, 1080], [1280, 720], [1600, 900], [2560, 1440]];
const RES_V = [[1080, 1920], [720, 1280]];

export function openSettings(initialTab = 'general') {
  const pane = h('div');
  const tabs = tabStrip([
    { id: 'general', label: t('General'), icon: 'settings' },
    { id: 'video', label: t('Video'), icon: 'tv' },
    { id: 'audio', label: t('Audio'), icon: 'speaker' },
    { id: 'rec', label: t('Recording & clips'), icon: 'scissors' },
    { id: 'privacy', label: t('Privacy Shield'), icon: 'shield' },
    { id: 'auto', label: t('Automation'), icon: 'wand' },
    { id: 'keys', label: t('Hotkeys'), icon: 'keyboard' },
    { id: 'about', label: t('About'), icon: 'info' },
  ], (id) => {
    clear(pane);
    const body = h('div.tab-pane');
    ({ general, video, audio, rec, privacy, auto, keys, about })[id](body);
    pane.append(body);
  }, initialTab);
  const m = openModal({ title: t('Settings'), width: 860, tabs: tabs.el, body: pane, actions: [h('button.btn.btn-primary', { onClick: () => m.close() }, t('Done'))] });
}

const S = () => state.settings;
const save = (topic = 'settings') => commit(topic);

function general(el) {
  const s = S();
  el.append(
    field(t('Language'), segmented(getLang(), [{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }], (v) => app.actions.setLanguage(v))),
    field(t('Countdown before going live'), segmented(s.countdown, [0, 3, 5, 10].map((v) => ({ value: v, label: v ? `${v}s` : t('Off') })), (v) => { s.countdown = Number(v); save(); })),
    field(t('Confirm before ending'), toggle(s.confirmEnd, (v) => { s.confirmEnd = v; save(); })),
    field(t('Prefer dedicated GPU'), toggle(s.highPerformanceGpu !== false, (v) => { s.highPerformanceGpu = v; save(); toast(t('Restart Lumacast to apply'), { type: 'info' }); }), t('Uses your NVIDIA/AMD graphics card for rendering and encoding on laptops with two GPUs.')),
    field(t('RTMP connection'), segmented(s.rtmpEngine || 'native', [
      { value: 'native', label: t('Built-in (fast)') }, { value: 'ffmpeg', label: t('FFmpeg (compatibility)') },
    ], (v) => { s.rtmpEngine = v; save(); }), t('Built-in uses less CPU and reacts faster to network problems. Switch to FFmpeg if a platform refuses the connection.')),
    section('FFmpeg'),
    field(t('FFmpeg'), h('div.ctrl', { style: { flex: 1 } },
      textInput(s.ffmpegPath || (rt.info && rt.info.ffmpeg) || '', (v) => { s.ffmpegPath = v; }, { mono: true, lazy: true, placeholder: t('auto-detect') }),
      h('button.btn.btn-sm', { onClick: async () => {
        const r = await window.lc.invoke('ffmpeg:set', s.ffmpegPath);
        rt.info.ffmpeg = r.ffmpeg;
        rt.info.ffmpegVersion = r.version;
        save();
        toast(r.ffmpeg ? t('FFmpeg {v} ready', { v: r.version }) : t('FFmpeg not found'), { type: r.ffmpeg ? 'ok' : 'err' });
      } }, t('Apply'))),
    rt.info && rt.info.ffmpeg ? t('Found: {v}', { v: rt.info.ffmpegVersion || '' }) : t('Install with: winget install Gyan.FFmpeg')),
  );
}

function video(el) {
  const v = S().video;
  const locked = rt.engine;
  if (locked) el.append(note(t('Video settings are locked while you are live, recording or the replay buffer runs.'), 'warn'));
  const resSel = (cur, list, onChange) => select(`${cur.width}x${cur.height}`, list.map(([w, hh]) => ({ value: `${w}x${hh}`, label: `${w} × ${hh}` })), (val) => {
    const [w, hh] = val.split('x').map(Number);
    onChange(w, hh);
  });
  const apply = () => { save('settings'); app.actions.videoChanged(); };
  const box = h('div', { style: locked ? { opacity: 0.5, pointerEvents: 'none' } : null },
    section(t('16:9 canvas')),
    field(t('Resolution'), resSel(v.h, RES_H, (w, hh) => app.actions.setResolution('h', w, hh))),
    field(t('Frame rate'), segmented(v.h.fps, [{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps' }], (x) => { v.h.fps = Number(x); apply(); })),
    field(t('Bitrate'), rangeInput(v.h.kbps, (x) => { v.h.kbps = x; save(); }, { min: 1500, max: 12000, step: 250, fmt: (x) => `${(x / 1000).toFixed(2)} Mbit/s` }), t('Twitch: up to 6 Mbit/s. YouTube accepts more.')),
    section(t('9:16 canvas (TikTok, Shorts, Reels)')),
    field(t('Dual canvas'), toggle(v.v.enabled, (x) => app.actions.setVertical(x))),
    field(t('Resolution'), resSel(v.v, RES_V, (w, hh) => app.actions.setResolution('v', w, hh))),
    field(t('Frame rate'), segmented(v.v.fps, [{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps' }], (x) => { v.v.fps = Number(x); apply(); })),
    field(t('Bitrate'), rangeInput(v.v.kbps, (x) => { v.v.kbps = x; save(); }, { min: 1000, max: 8000, step: 250, fmt: (x) => `${(x / 1000).toFixed(2)} Mbit/s` })),
    section(t('Encoder')),
    field(t('H.264 encoder'), segmented(v.encoder || 'auto', [
      { value: 'auto', label: t('Auto') }, { value: 'hardware', label: t('Hardware (GPU)') }, { value: 'software', label: t('Software (CPU)') },
    ], (x) => { v.encoder = x; save(); }), t('Auto encodes 16:9 on your GPU and 9:16 on the CPU, and falls back to the CPU if the GPU can’t keep up.')),
    field(t('Adaptive bitrate'), toggle(v.adaptive, (x) => { v.adaptive = x; save(); }), t('Lowers the bitrate automatically when your upload can’t keep up, then recovers.')),
  );
  el.append(box);
  const dests = state.destinations.filter((d) => d.enabled);
  const kbps = dests.reduce((a, d) => a + (d.canvas === 'v' && v.v.enabled ? v.v.kbps : v.h.kbps) + S().audio.kbps, 0);
  if (dests.length) el.append(h('div', { style: { height: '10px' } }), note(t('Each destination uploads its own copy. With {n} destinations you need roughly {mbit} Mbit/s upload (plus headroom).', { n: dests.length, mbit: (kbps / 1000).toFixed(1) })));
}

function audio(el) {
  const a = S().audio;
  el.append(
    field(t('Audio bitrate'), segmented(a.kbps, [128, 160, 192, 256, 320].map((x) => ({ value: x, label: `${x}k` })), (x) => { a.kbps = Number(x); save(); })),
    field(t('A/V sync offset'), rangeInput(a.syncOffsetMs || 0, (x) => { a.syncOffsetMs = x; save(); }, { min: -500, max: 500, step: 10, fmt: (x) => `${x > 0 ? '+' : ''}${x} ms` }), t('Positive values delay the audio. Applies the next time the encoder starts.')),
    note(t('Mic noise suppression, noise gate and voice compressor are set per channel with the gear icon in the mixer.')),
  );
}

function rec(el) {
  const r = S().recording;
  const rp = S().replay;
  const hy = S().hype;
  const folder = textInput(r.folder || (rt.info && rt.info.videosDir) || '', (v) => { r.folder = v; save(); }, { lazy: true });
  el.append(
    section(t('Recording')),
    field(t('Folder'), h('div.ctrl', { style: { flex: 1 } }, folder,
      h('button.btn.btn-sm', { onClick: async () => {
        const p = await window.lc.invoke('dialog:folder', { title: t('Recording folder'), defaultPath: folder.value });
        if (p) { folder.value = p; r.folder = p; save(); }
      } }, icon('folder', 13), t('Browse')),
      h('button.icon-btn', { title: t('Open folder'), onClick: () => window.lc.invoke('shell:open', folder.value) }, icon('external', 14)))),
    field(t('Save as MP4'), toggle(r.remux, (v) => { r.remux = v; save(); }), t('Records crash-safe MKV, then converts to MP4 when you stop.')),
    field(t('Also record 9:16'), toggle(r.vertical, (v) => { r.vertical = v; save(); })),
    section(t('Instant replay')),
    field(t('Replay length'), rangeInput(rp.seconds, (v) => { rp.seconds = v; save(); if (rt.replay) window.lc.invoke('engine:replay', v); }, { min: 10, max: 120, step: 5, fmt: (v) => `${v}s` })),
    field(t('Start with stream'), toggle(rp.autoStart, (v) => { rp.autoStart = v; save(); }), t('Turns the replay buffer on automatically when you go live.')),
    section(t('Hype clips')),
    field(t('Auto-clip chat hype'), toggle(hy.enabled, (v) => { hy.enabled = v; save(); }), t('When chat suddenly explodes, Lumacast saves the last moments as 16:9 and 9:16 clips and drops a marker.')),
    field(t('Sensitivity'), rangeInput(hy.sensitivity, (v) => { hy.sensitivity = v; save(); }, { min: 1, max: 5, fmt: (v) => [t('very calm'), t('calm'), t('normal'), t('eager'), t('very eager')][v - 1] })),
    field(t('Cooldown'), rangeInput(hy.cooldown, (v) => { hy.cooldown = v; save(); }, { min: 30, max: 600, step: 15, fmt: (v) => `${v}s` })),
  );
}

function privacy(el) {
  const p = S().privacy;
  const chips = h('div.keychips');
  const drawChips = () => {
    clear(chips).append(...p.keywords.map((k) => h('span.keychip', k, h('button', { title: t('Remove'), onClick: () => { p.keywords = p.keywords.filter((x) => x !== k); save(); drawChips(); app.automation.apply(); } }, icon('x', 11)))));
  };
  drawChips();
  const add = textInput('', () => {}, { placeholder: t('Add a word, app or site…') });
  add.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !add.value.trim()) return;
    if (!p.keywords.includes(add.value.trim())) p.keywords.push(add.value.trim());
    add.value = '';
    save();
    drawChips();
  });
  el.append(
    note(t('Privacy Shield watches which window is in focus. When it matches one of these words, every screen capture is blurred on stream instantly — and un-blurred when you switch away.')),
    field(t('Enabled'), toggle(p.enabled, (v) => { p.enabled = v; save(); app.automation.apply(); })),
    field(t('Also blur window captures'), toggle(p.windows, (v) => { p.windows = v; save(); })),
    field(t('On-stream message'), textInput(p.message, (v) => { p.message = v; save(); })),
    field(t('Trigger words'), h('div', { style: { flex: 1, display: 'grid', gap: '8px' } }, chips, add), t('Matched against the window title and the program name.')),
    field('', h('div.row-gap',
      h('button.btn.btn-sm', { onClick: () => { app.automation.togglePrivacy(true); setTimeout(() => app.automation.togglePrivacy(false), 3000); } }, icon('shieldOn', 13), t('Test for 3 seconds')),
      h('button.btn.btn-sm.btn-ghost', { onClick: () => { p.keywords = DEFAULT_PRIVACY_KEYWORDS.slice(); save(); drawChips(); } }, t('Reset words')))),
  );
}

function auto(el) {
  const list = h('div', { style: { display: 'grid', gap: '8px' } });
  const sceneOpts = () => state.scenes.map((s) => ({ value: s.id, label: s.name }));
  const draw = () => {
    clear(list);
    if (!state.rules.length) list.append(h('div.empty', t('No rules yet.')));
    state.rules.forEach((r) => {
      const isWin = r.when.type === 'window';
      list.append(h('div.dest', { style: { gridTemplateColumns: 'auto 1fr auto', marginBottom: 0 } },
        toggle(r.enabled, (v) => { r.enabled = v; save('rules'); app.automation.apply(); }),
        h('div.row-gap', { style: { gap: '6px' } },
          h('span.muted', isWin ? t('When the focused window contains') : t('When the mic is silent for')),
          isWin
            ? textInput(r.when.match, (v) => { r.when.match = v; save('rules'); }, { placeholder: t('e.g. valorant') })
            : numInput(r.when.minutes || 3, (v) => { r.when.minutes = v; save('rules'); }, { min: 1, max: 60 }),
          isWin ? null : h('span.muted', t('min while live')),
          h('span.muted', t('switch to')),
          select(r.scene, sceneOpts(), (v) => { r.scene = v; save('rules'); }),
          isWin ? null : h('label.row-gap', { style: { gap: '6px' } }, toggle(r.returnBack, (v) => { r.returnBack = v; save('rules'); }), h('span.muted', t('and back when I talk')))),
        h('button.icon-btn.danger', { onClick: () => { state.rules = state.rules.filter((x) => x !== r); save('rules'); draw(); app.automation.apply(); } }, icon('trash', 14))));
    });
  };
  draw();
  const first = state.scenes[0] ? state.scenes[0].id : '';
  el.append(
    note(t('Rules switch scenes for you — for example to your gameplay scene when the game gets focus, or to “Be right back” when you go quiet.')),
    h('div', { style: { height: '10px' } }),
    list,
    h('div.row-gap', { style: { marginTop: '10px' } },
      h('button.btn.btn-sm', { onClick: () => { state.rules.push({ id: uid('rule'), enabled: true, when: { type: 'window', match: '' }, scene: first }); save('rules'); draw(); app.automation.apply(); } }, icon('window', 13), t('Window rule')),
      h('button.btn.btn-sm', { onClick: () => { const brb = state.scenes.find((s) => /brb|right back|gleich/i.test(s.name)); state.rules.push({ id: uid('rule'), enabled: true, when: { type: 'silence', minutes: 5 }, scene: brb ? brb.id : first, returnBack: true }); save('rules'); draw(); } }, icon('micOff', 13), t('Silence rule'))),
  );
}

const ACTIONS = [
  ['goLive', 'Go Live / End stream'], ['record', 'Start / stop recording'], ['clip', 'Save clip'],
  ['marker', 'Add marker'], ['privacy', 'Privacy Shield'], ['muteMic', 'Mute microphone'],
];

function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = `num${c.slice(6)}`;
  else key = { Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Pause: 'Pause', ScrollLock: 'Scrolllock' }[c] || null;
  if (!key) return null;
  if (!mods.length && !/^F\d/.test(key) && !['Pause', 'Scrolllock', 'Insert'].includes(key)) return null;
  return [...mods, key].join('+');
}

function keys(el) {
  const hk = S().hotkeys;
  const apply = async () => {
    save();
    const failed = await window.lc.invoke('hotkeys:set', hk);
    if (failed.length) toast(t('Some hotkeys are taken by another app'), { type: 'warn', text: failed.join(', ') });
  };
  el.append(note(t('Hotkeys work everywhere, even while you are in a game. Click a field and press the combination; Backspace clears it.')));
  for (const [id, label] of ACTIONS) {
    const input = h('input.input.hotkey-input', { value: hk[id] || '', placeholder: t('not set'), readOnly: true });
    input.addEventListener('focus', () => { input.classList.add('listening'); input.value = t('Press keys…'); });
    input.addEventListener('blur', () => { input.classList.remove('listening'); input.value = hk[id] || ''; });
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { input.blur(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { hk[id] = ''; input.blur(); apply(); return; }
      const acc = accelFromEvent(e);
      if (acc) {
        hk[id] = acc;
        input.blur();
        apply();
      }
    });
    el.append(field(t(label), input));
  }
  el.append(field(t('Scenes'), h('span.muted', t('Ctrl+1 … Ctrl+9 switch scenes while Lumacast is focused.'))));
}

function about(el) {
  const i = rt.info || {};
  const row = (k, v) => field(k, h('span', { style: { userSelect: 'text' } }, v || '—'));
  el.append(
    h('div.welcome-hero', { style: { padding: '8px 0 14px' } }, h('div.brand-mark', { style: { margin: '0 auto', width: '44px', height: '44px', borderRadius: '14px' } }), h('h1', 'Lumacast'), h('p', t('Multistream studio for Twitch, YouTube and TikTok.'))),
    row(t('Version'), i.version),
    row('Electron / Chromium', `${i.electron} / ${i.chrome}`),
    row('FFmpeg', i.ffmpeg ? `${i.ffmpegVersion} — ${i.ffmpeg}` : t('not found')),
    row(t('Encoder'), app.output.encoderInfo || t('starts with your first stream')),
    field(t('Files'), h('div.row-gap',
      h('button.btn.btn-sm', { onClick: () => window.lc.invoke('shell:reveal', i.logFile) }, icon('folder', 13), t('Log file')),
      h('button.btn.btn-sm', { onClick: () => window.lc.invoke('shell:open', i.userData) }, icon('folder', 13), t('Settings folder')))),
  );
}
