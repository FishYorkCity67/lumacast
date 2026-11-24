// "Add source" picker and the per-source properties modal (live preview while
// editing), including the screen/window capture picker and layout controls.
import { h, clear } from '../util.js';
import { icon, SOURCE_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, commit, activeScene, addSourceToScene, canvasSize, verticalEnabled } from '../state.js';
import { app } from '../ctx.js';
import {
  openModal, field, textInput, textArea, numInput, rangeInput, toggle, select, colorInput, fileInput, segmented, section, note, toast,
} from './common.js';
import { transform } from './items.js';
import { drawAvatar, AVATAR_STYLES, AVATAR_ACCESSORIES, AVATAR_COLORS } from '../avatars.js';

const FONTS = ['Segoe UI Variable Display', 'Segoe UI', 'Bahnschrift', 'Arial Black', 'Impact', 'Georgia', 'Consolas', 'Cascadia Code', 'Trebuchet MS', 'Verdana', 'Comic Sans MS', 'Ink Free', 'Segoe Print', 'Gabriola'];
const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'avif', 'bmp'] }];
const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v'] }];

const TYPES = [
  { type: 'display', label: 'Screen', desc: 'Capture a whole monitor' },
  { type: 'window', label: 'Window', desc: 'Capture a single app or game' },
  { type: 'camera', label: 'Camera', desc: 'Webcam with rounded corners and animated borders' },
  { type: 'image', label: 'Image / GIF', desc: 'PNG, JPG and animated GIF / WebP' },
  { type: 'media', label: 'Video file', desc: 'Looping clips with sound' },
  { type: 'text', label: 'Text', desc: 'Titles with wave, typewriter and marquee effects' },
  { type: 'timer', label: 'Timer', desc: 'Countdown, stopwatch or clock' },
  { type: 'color', label: 'Background', desc: 'Solid, gradient or animated aurora' },
  { type: 'chat', label: 'Chat overlay', desc: 'Twitch + YouTube chat, rendered natively', fresh: true },
  { type: 'alerts', label: 'Alerts', desc: 'Subs, raids, cheers and Super Chats', fresh: true },
  { type: 'avatar', label: 'Voice avatar', desc: 'PNGtuber that bounces when you talk', fresh: true },
  { type: 'browser', label: 'Browser', desc: 'Web widgets: alert boxes, goals, tickers' },
];

function defaults(type) {
  switch (type) {
    case 'camera': return { deviceId: '', resolution: '1080p', fps: 30, mirror: false, radius: 16, border: 0, borderStyle: 'gradient', borderColor: '#7c5cff', borderColor2: '#22d3ee', shadow: true };
    case 'media': return { file: '', loop: true, volume: 1 };
    case 'text': return { text: t('Your text'), font: 'Segoe UI Variable Display', size: 72, weight: 700, color: '#ffffff', color2: '#a5b4fc', gradient: false, outline: 0, outlineColor: '#000000', shadow: true, bgOpacity: 0, bg: '#000000', align: 'center', anim: 'none', speed: 1 };
    case 'timer': return { mode: 'countdown', minutes: 5, endText: t("We're live!"), restartOnShow: true, font: 'Segoe UI Variable Display', size: 72, weight: 700, color: '#ffffff', shadow: true, outline: 0, outlineColor: '#000000' };
    case 'color': return { mode: 'aurora', color: '#7c5cff', color2: '#22d3ee', color3: '#ff4fa3', angle: 135 };
    case 'chat': return { fontSize: 26, max: 10, fade: 0, showPlatform: true, bg: 0.55 };
    case 'alerts': return { duration: 6, sound: true };
    case 'avatar': return { style: 'cat', accessory: 'headphones', color: '', blinking: true, idle: '', talk: '', inputId: 'mic', threshold: -38, bounce: 1 };
    case 'browser': return { url: '', width: 1280, height: 720, fps: 30, css: '', muted: false };
    default: return {};
  }
}

export function openAddSource() {
  if (!activeScene()) return;
  const m = openModal({
    title: t('Add a source'), sub: t('to “{scene}”', { scene: activeScene().name }), width: 720,
    body: h('div.type-grid', TYPES.map((ty, i) => h('button.type-card', {
      style: { '--i': i },
      onClick: async () => {
        m.close();
        await createSource(ty);
      },
    }, h('div.row-gap', { style: { justifyContent: 'space-between' } }, icon(SOURCE_ICONS[ty.type], 18), ty.fresh ? h('span.new', t('UNIQUE')) : null),
    h('b', t(ty.label)), h('span', t(ty.desc))))),
  });
}

async function createSource(ty) {
  const settings = defaults(ty.type);
  if (ty.type === 'camera') {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (!devs.length) {
      toast(t('No camera found'), { type: 'warn' });
      return;
    }
    settings.deviceId = devs[0].deviceId;
  }
  const count = Object.values(state.sources).filter((s) => s.type === ty.type).length;
  const name = count ? `${t(ty.label)} ${count + 1}` : t(ty.label);
  const { item } = addSourceToScene(ty.type, name, settings);
  rt.selection = item.id;
  commit('sources');
  commit('items');
  openProperties(item.id, true);
}

export function openProperties(itemId, isNew = false) {
  const scene = activeScene();
  const item = scene && scene.items.find((i) => i.id === itemId);
  if (!item) return;
  const src = state.sources[item.sourceId];
  if (!src) return;
  const s = src.settings;
  const set = (k, v) => {
    s[k] = v;
    commit('sources');
  };
  const body = h('div');
  const nameInput = textInput(src.name, (v) => { src.name = v || src.name; commit('sources'); });
  body.append(field(t('Name'), nameInput));
  const typeBody = h('div');
  body.append(typeBody);
  buildType(src, s, set, typeBody);
  body.append(layoutSection(item, src));
  const m = openModal({
    title: h('span.row-gap', icon(SOURCE_ICONS[src.type], 18), isNew ? t('New {type}', { type: t((TYPES.find((x) => x.type === src.type) || {}).label || src.type) }) : src.name),
    width: 680,
    body,
    actions: [h('button.btn.btn-primary', { onClick: () => m.close() }, icon('check', 14), t('Done'))],
  });
}

function buildType(src, s, set, el) {
  const type = src.type;
  if (type === 'display' || type === 'window') {
    el.append(capturePicker(type, s, set));
    if (type === 'display') el.append(note(t('Privacy Shield blurs this capture automatically when a password manager, banking site or messenger is focused.')));
    else el.append(note(t('Fullscreen games (e.g. Minecraft with F11) minimize when you switch away and can’t be captured then — Lumacast picks them up again as soon as you are back in the game. Windowed mode avoids the gap.')));
    return;
  }
  if (type === 'camera') {
    const devSel = select(s.deviceId, [{ value: s.deviceId, label: t('Loading…') }], (v) => set('deviceId', v));
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const cams = devs.filter((d) => d.kind === 'videoinput');
      clear(devSel).append(...cams.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === s.deviceId }, d.label || `${t('Camera')} ${i + 1}`)));
    });
    el.append(
      field(t('Device'), devSel),
      field(t('Resolution'), segmented(s.resolution || '1080p', ['720p', '1080p', '1440p', '4k'].map((v) => ({ value: v, label: v })), (v) => set('resolution', v))),
      field(t('Frame rate'), segmented(s.fps || 30, [{ value: 30, label: '30' }, { value: 60, label: '60' }], (v) => set('fps', Number(v)))),
      field(t('Mirror'), toggle(s.mirror, (v) => set('mirror', v))),
      section(t('Style')),
      field(t('Corner radius'), rangeInput(s.radius || 0, (v) => set('radius', v), { min: 0, max: 100, fmt: (v) => (v >= 100 ? t('circle') : `${v}%`) })),
      field(t('Border'), rangeInput(s.border || 0, (v) => set('border', v), { min: 0, max: 30, fmt: (v) => `${v}px` })),
      field(t('Border style'), select(s.borderStyle || 'solid', [
        { value: 'solid', label: t('Solid') }, { value: 'gradient', label: t('Animated gradient') }, { value: 'rainbow', label: t('Animated rainbow') },
      ], (v) => set('borderStyle', v))),
      field(t('Border colors'), h('div.row-gap', colorInput(s.borderColor, (v) => set('borderColor', v)), colorInput(s.borderColor2, (v) => set('borderColor2', v)))),
      field(t('Drop shadow'), toggle(s.shadow, (v) => set('shadow', v))),
    );
    return;
  }
  if (type === 'image') {
    el.append(field(t('File'), fileInput(s.file, (v) => set('file', v), { filters: IMAGE_FILTERS })), note(t('Animated GIF, WebP and APNG files play automatically.')));
    return;
  }
  if (type === 'media') {
    el.append(
      field(t('File'), fileInput(s.file, (v) => set('file', v), { filters: VIDEO_FILTERS })),
      field(t('Loop'), toggle(s.loop !== false, (v) => set('loop', v))),
      field(t('Restart when scene opens'), toggle(s.restartOnShow, (v) => set('restartOnShow', v))),
      note(t('Its audio shows up as its own channel in the mixer.')),
    );
    return;
  }
  if (type === 'text') {
    el.append(field(t('Text'), textArea(s.text, (v) => set('text', v))));
    textStyle(el, s, set, true);
    return;
  }
  if (type === 'timer') {
    const sceneOpts = [{ value: '', label: t('— stay —') }, ...state.scenes.map((sc) => ({ value: sc.id, label: sc.name }))];
    el.append(
      field(t('Mode'), segmented(s.mode || 'countdown', [
        { value: 'countdown', label: t('Countdown') }, { value: 'stopwatch', label: t('Stopwatch') }, { value: 'clock', label: t('Clock') },
      ], (v) => set('mode', v))),
      field(t('Minutes'), numInput(s.minutes || 5, (v) => set('minutes', v), { min: 0.1, max: 600, step: 0.5 })),
      field(t('Prefix'), textInput(s.prefix || '', (v) => set('prefix', v), { placeholder: t('e.g. Starting in ') })),
      field(t('Text at zero'), textInput(s.endText || '', (v) => set('endText', v))),
      field(t('At zero switch to'), select(s.endSceneId || '', sceneOpts, (v) => set('endSceneId', v)), t('Turns your “Starting soon” scene into an automatic go-live.')),
      field(t('Restart when scene opens'), toggle(s.restartOnShow !== false, (v) => set('restartOnShow', v))),
      field('', h('button.btn.btn-sm', { onClick: () => { const r = app.mgr.get(src.id); if (r && r.restart) r.restart(); } }, icon('refresh', 13), t('Restart now'))),
    );
    textStyle(el, s, set, false);
    return;
  }
  if (type === 'color') {
    el.append(
      field(t('Style'), segmented(s.mode || 'solid', [
        { value: 'solid', label: t('Solid') }, { value: 'gradient', label: t('Gradient') }, { value: 'aurora', label: t('Aurora (animated)') },
      ], (v) => set('mode', v))),
      field(t('Colors'), h('div.row-gap', colorInput(s.color, (v) => set('color', v)), colorInput(s.color2 || '#22d3ee', (v) => set('color2', v)), colorInput(s.color3 || '#ff4fa3', (v) => set('color3', v)))),
      field(t('Angle'), rangeInput(s.angle ?? 135, (v) => set('angle', v), { min: 0, max: 360, fmt: (v) => `${v}°` })),
    );
    return;
  }
  if (type === 'chat') {
    el.append(
      field(t('Font size'), rangeInput(s.fontSize || 26, (v) => set('fontSize', v), { min: 12, max: 64, fmt: (v) => `${v}px` })),
      field(t('Max messages'), rangeInput(s.max || 10, (v) => set('max', v), { min: 1, max: 30 })),
      field(t('Fade out after'), rangeInput(s.fade || 0, (v) => set('fade', v), { min: 0, max: 120, fmt: (v) => (v ? `${v}s` : t('never')) })),
      field(t('Bubble opacity'), rangeInput(Math.round((s.bg ?? 0.55) * 100), (v) => set('bg', v / 100), { min: 0, max: 100, fmt: (v) => `${v}%` })),
      field(t('Platform color bar'), toggle(s.showPlatform !== false, (v) => set('showPlatform', v))),
      note(t('Messages removed by your moderators disappear from the overlay instantly.')),
    );
    if (!state.settings.chat.twitch && !state.settings.chat.youtube) {
      el.append(h('div', { style: { height: '8px' } }), h('button.btn.btn-sm.btn-primary', { onClick: () => app.actions.openChatSettings() }, icon('chat', 13), t('Connect your chats')));
    }
    return;
  }
  if (type === 'alerts') {
    const test = (kind) => app.actions.testAlert(kind);
    el.append(
      field(t('Duration'), rangeInput(s.duration || 6, (v) => set('duration', v), { min: 3, max: 15, fmt: (v) => `${v}s` })),
      field(t('Sound'), toggle(s.sound !== false, (v) => set('sound', v)), t('A short chime is mixed into the stream (not your speakers).')),
      field(t('Test'), h('div.row-gap', ['sub', 'gift', 'raid', 'cheer', 'superchat', 'member'].map((k) => h('button.btn.btn-sm', { onClick: () => test(k) }, k)))),
      note(t('Alerts come from your connected Twitch and YouTube chats — no extra accounts or browser sources needed.')),
    );
    return;
  }
  if (type === 'avatar') {
    const meter = h('div.meter', h('div.bar', h('div.fill')));
    const thr = h('div.peak');
    meter.firstChild.append(thr);
    const tick = () => {
      if (!meter.isConnected) return;
      const db = app.audio.level(s.inputId || 'mic');
      const p = Math.max(0, Math.min(1, (db + 60) / 60));
      meter.querySelector('.fill').style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
      thr.style.left = `${((s.threshold ?? -38) + 60) / 60 * 100}%`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const colorEl = colorInput(s.color || AVATAR_COLORS[s.style || 'blob'], (v) => set('color', v));
    el.append(
      field(t('Character'), avatarPicker(s, (style) => {
        s.color = AVATAR_COLORS[style];
        colorEl.value = s.color;
        set('style', style);
      }), t('Blinks, looks around, talks with your voice and jumps for joy on alerts.')),
      field(t('Accessory'), select(s.accessory || 'none', AVATAR_ACCESSORIES.map((a) => ({ value: a, label: t(ACCESSORY_LABELS[a]) })), (v) => set('accessory', v))),
      field(t('Avatar color'), colorEl),
      field(t('Blinking'), toggle(s.blinking !== false, (v) => set('blinking', v))),
      section(t('Voice')),
      field(t('Listen to'), select(s.inputId || 'mic', state.audioInputs.map((a) => ({ value: a.id, label: a.name })), (v) => set('inputId', v))),
      field(t('Voice level'), meter),
      field(t('Talk threshold'), rangeInput(s.threshold ?? -38, (v) => set('threshold', v), { min: -70, max: -5, fmt: (v) => `${v} dB` })),
      field(t('Bounce'), rangeInput(Math.round((s.bounce ?? 1) * 100), (v) => set('bounce', v / 100), { min: 0, max: 200, fmt: (v) => `${v}%` })),
      section(t('Own images (PNGtuber)')),
      field(t('Idle image'), fileInput(s.idle, (v) => set('idle', v), { filters: IMAGE_FILTERS })),
      field(t('Talking image'), fileInput(s.talk, (v) => set('talk', v), { filters: IMAGE_FILTERS })),
      field(t('Blink image'), fileInput(s.blinkImg, (v) => set('blinkImg', v), { filters: IMAGE_FILTERS }), t('Optional. Leave the images empty to use the animated character above.')),
    );
    return;
  }
  if (type === 'browser') {
    el.append(
      field(t('URL'), textInput(s.url, (v) => set('url', v.trim()), { mono: true, placeholder: 'https://…', lazy: true })),
      field(t('Size'), h('div.row-gap', numInput(s.width || 1280, (v) => set('width', v), { min: 16, max: 3840 }), '×', numInput(s.height || 720, (v) => set('height', v), { min: 16, max: 2160 }))),
      field(t('Frame rate'), segmented(s.fps || 30, [{ value: 15, label: '15' }, { value: 30, label: '30' }, { value: 60, label: '60' }], (v) => set('fps', Number(v)))),
      field(t('Custom CSS'), textArea(s.css || '', (v) => set('css', v), { placeholder: 'body { … }' })),
      field(t('Mute page audio'), toggle(s.muted, (v) => set('muted', v)), t('Page audio plays through your PC and is picked up by Desktop Audio.')),
      field('', h('button.btn.btn-sm', { onClick: () => { const r = app.mgr.get(src.id); if (r && r.reload) r.reload(); } }, icon('refresh', 13), t('Reload page'))),
      note(t('Paste alert-box, goal or ticker URLs from StreamElements, Streamlabs and similar services.')),
    );
  }
}

const STYLE_LABELS = { blob: 'Blob', cat: 'Cat', fox: 'Fox', bunny: 'Bunny', robot: 'Robot', ghost: 'Ghost', slime: 'Slime' };
const ACCESSORY_LABELS = { none: 'None', headphones: 'Headphones', crown: 'Crown', glasses: 'Glasses', partyhat: 'Party hat', bow: 'Bow' };

// Grid of live-animated previews of every built-in character.
function avatarPicker(s, onPick) {
  const cards = AVATAR_STYLES.map((style) => {
    const c = h('canvas', { width: 120, height: 120, style: { width: '60px', height: '60px' } });
    const card = h(`button.type-card${(s.style || 'blob') === style ? '.on' : ''}`, {
      style: { alignItems: 'center', padding: '8px 4px', gap: '4px', borderColor: (s.style || 'blob') === style ? 'var(--accent)' : '' },
      onClick: () => {
        cards.forEach((x) => { x.card.classList.remove('on'); x.card.style.borderColor = ''; });
        card.classList.add('on');
        card.style.borderColor = 'var(--accent)';
        onPick(style);
      },
    }, c, h('span', { style: { fontSize: '11px' } }, t(STYLE_LABELS[style])));
    return { card, c, style, ctx: c.getContext('2d'), seed: Math.random() * 10 };
  });
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: '6px', flex: 1, minWidth: 0 } }, cards.map((x) => x.card));
  const tick = (now) => {
    if (!grid.isConnected && grid.dataset.mounted) return;
    if (grid.isConnected) grid.dataset.mounted = '1';
    const tt = now / 1000;
    for (const x of cards) {
      x.ctx.clearRect(0, 0, 120, 120);
      const blinkPhase = (tt + x.seed) % 3.4;
      const blink = blinkPhase < 0.15 ? 1 - Math.abs(blinkPhase / 0.075 - 1) : 0;
      const talk = Math.max(0, Math.sin(tt * 1.3 + x.seed)) > 0.6 ? 1 : 0;
      drawAvatar(x.ctx, 120, 120, {
        style: x.style, color: x.style === (s.style || 'blob') && s.color ? s.color : AVATAR_COLORS[x.style],
        accessory: s.accessory || 'none', t: tt + x.seed, talk, level: 0.6, mouth: talk * (0.4 + 0.3 * Math.sin(tt * 20)),
        blink, lookX: Math.sin(tt * 0.7 + x.seed), lookY: 0, happy: 0, jump: 0, squash: 0,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return grid;
}

function textStyle(el, s, set, full) {
  el.append(
    section(t('Style')),
    field(t('Font'), select(s.font || FONTS[0], FONTS.map((f) => ({ value: f, label: f })), (v) => set('font', v))),
    field(t('Size'), rangeInput(s.size || 72, (v) => set('size', v), { min: 12, max: 300, fmt: (v) => `${v}px` })),
    field(t('Weight'), segmented(s.weight || 700, [{ value: 400, label: t('Regular') }, { value: 600, label: t('Semibold') }, { value: 800, label: t('Heavy') }], (v) => set('weight', Number(v)))),
    field(t('Color'), h('div.row-gap', colorInput(s.color, (v) => set('color', v)), h('span.muted', t('Gradient')), toggle(s.gradient, (v) => set('gradient', v)), colorInput(s.color2 || '#a5b4fc', (v) => set('color2', v)))),
    field(t('Outline'), h('div.row-gap', { style: { flex: 1 } }, rangeInput(s.outline || 0, (v) => set('outline', v), { min: 0, max: 20, fmt: (v) => `${v}px` }), colorInput(s.outlineColor || '#000000', (v) => set('outlineColor', v)))),
    field(t('Shadow'), toggle(s.shadow, (v) => set('shadow', v))),
    field(t('Background'), h('div.row-gap', { style: { flex: 1 } }, rangeInput(Math.round((s.bgOpacity || 0) * 100), (v) => set('bgOpacity', v / 100), { min: 0, max: 100, fmt: (v) => `${v}%` }), colorInput(s.bg || '#000000', (v) => set('bg', v)))),
  );
  if (full) {
    el.append(
      field(t('Align'), segmented(s.align || 'center', [{ value: 'left', label: t('Left') }, { value: 'center', label: t('Center') }, { value: 'right', label: t('Right') }], (v) => set('align', v))),
      field(t('Animation'), select(s.anim || 'none', [
        { value: 'none', label: t('None') }, { value: 'pulse', label: t('Pulse') }, { value: 'glow', label: t('Glow') },
        { value: 'wave', label: t('Wave') }, { value: 'typewriter', label: t('Typewriter') }, { value: 'marquee', label: t('Scrolling ticker') },
      ], (v) => set('anim', v))),
      field(t('Speed'), rangeInput(Math.round((s.speed || 1) * 100), (v) => set('speed', v / 100), { min: 25, max: 300, fmt: (v) => `${v}%` })),
    );
  } else {
    el.append(field(t('Animation'), select(s.anim || 'none', [{ value: 'none', label: t('None') }, { value: 'pulse', label: t('Pulse') }, { value: 'glow', label: t('Glow') }], (v) => set('anim', v))));
  }
}

function capturePicker(type, s, set) {
  const kind = type === 'window' ? 'window' : 'screen';
  const grid = h('div.cap-grid');
  const load = async () => {
    clear(grid).append(h('div.empty', t('Looking for {what}…', { what: kind === 'window' ? t('windows') : t('screens') })));
    const list = await window.lc.invoke('capture:sources', [kind]);
    clear(grid);
    if (!list.length) grid.append(h('div.empty', t('Nothing found.')));
    list.forEach((c, i) => {
      const card = h(`div.cap${c.id === s.sourceId ? '.on' : ''}`, {
        style: { '--i': i },
        onClick: () => {
          grid.querySelectorAll('.cap').forEach((n) => n.classList.remove('on'));
          card.classList.add('on');
          s.name = c.name;
          s.displayId = c.displayId;
          s.process = c.process || '';
          s.app = c.name.includes(' - ') ? c.name.slice(c.name.lastIndexOf(' - ')) : '';
          set('sourceId', c.id);
        },
      },
      c.thumbnail ? h('img', { src: c.thumbnail })
        : h('div', { style: { aspectRatio: '16/9', background: '#05060c', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '10px', fontSize: '11px', color: 'var(--text-3)' } },
          c.minimized ? t('Minimized – capture starts when you switch to it') : ''),
      h('div.cap-name', c.icon ? h('img', { src: c.icon }) : icon(kind === 'window' ? 'window' : 'monitor', 14), h('span', { title: c.name }, c.name)));
      grid.append(card);
    });
  };
  load();
  return h('div',
    h('div.row-gap', { style: { justifyContent: 'space-between', margin: '4px 0 10px' } },
      h('span.muted', kind === 'window' ? t('Pick the window to capture. Lumacast finds it again after restarts.') : t('Pick a monitor.')),
      h('button.btn.btn-sm', { onClick: load }, icon('refresh', 13), t('Refresh'))),
    grid);
}

function layoutSection(item, src) {
  const wrap = h('div');
  const draw = () => {
    clear(wrap);
    const key = rt.editCanvas;
    const L = item[key];
    const { w: W, h: H } = canvasSize(key);
    const upd = () => commit('items');
    const num = (k, opts = {}) => numInput(Math.round(L[k] || 0), (v) => { L[k] = v; upd(); }, opts);
    const cropNum = (k) => numInput(Math.round((L.crop || {})[k] || 0), (v) => { L.crop = { l: 0, t: 0, r: 0, b: 0, ...L.crop, [k]: Math.max(0, v) }; upd(); }, { min: 0 });
    wrap.append(
      section(t('Position on {c} canvas', { c: key === 'v' ? '9:16' : '16:9' })),
      verticalEnabled() ? field(t('Canvas'), segmented(key, [{ value: 'h', icon: 'tv', label: '16:9' }, { value: 'v', icon: 'phone', label: '9:16' }], (v) => { app.panels.find((p) => p.setEdit).setEdit(v); draw(); })) : null,
      field(t('Show on this canvas'), toggle(L.show !== false, (v) => { L.show = v; upd(); })),
      field(t('Position'), h('div.row-gap', 'X', num('x'), 'Y', num('y'))),
      field(t('Size'), h('div.row-gap', 'W', num('w', { min: 1 }), 'H', num('h', { min: 1 }), h('span.muted', `/ ${W}×${H}`))),
      field(t('Rotation'), rangeInput(L.rot || 0, (v) => { L.rot = v; upd(); }, { min: -180, max: 180, fmt: (v) => `${v}°` })),
      field(t('Opacity'), rangeInput(Math.round((L.opacity ?? 1) * 100), (v) => { L.opacity = v / 100; upd(); }, { min: 0, max: 100, fmt: (v) => `${v}%` })),
      ['display', 'window', 'camera', 'image', 'media', 'browser'].includes(src.type)
        ? field(t('Crop (px)'), h('div.row-gap', t('L'), cropNum('l'), t('T'), cropNum('t'), t('R'), cropNum('r'), t('B'), cropNum('b')))
        : null,
      field('', h('div.row-gap',
        h('button.btn.btn-sm', { onClick: () => { transform(item, key, 'fit'); draw(); } }, icon('fit', 13), t('Fit')),
        h('button.btn.btn-sm', { onClick: () => { transform(item, key, 'cover'); draw(); } }, icon('layout', 13), t('Fill')),
        h('button.btn.btn-sm', { onClick: () => { transform(item, key, 'center'); draw(); } }, icon('center', 13), t('Center')),
        h('button.btn.btn-sm', { onClick: () => { transform(item, key, 'reset'); draw(); } }, icon('refresh', 13), t('Reset')))),
    );
  };
  draw();
  return wrap;
}
