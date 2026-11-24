// Persistent studio state (scenes, sources, settings, destinations) plus
// runtime-only flags. Modules mutate `state` and call commit(topic).
import { Emitter, uid, debounce, deepClone } from './util.js';

export const bus = new Emitter();

export const PLATFORMS = {
  twitch: {
    name: 'Twitch', color: '#9146ff', canvas: 'h', maxKbps: 6000,
    server: 'rtmp://live.twitch.tv/app',
    servers: ['rtmp://live.twitch.tv/app', 'rtmps://live.twitch.tv:443/app', 'rtmp://ingest.global-contribute.live-video.net/app'],
    keyUrl: 'https://dashboard.twitch.tv/settings/stream',
    chatUrl: (c) => `https://www.twitch.tv/popout/${encodeURIComponent(c)}/chat?popout=`,
  },
  youtube: {
    name: 'YouTube', color: '#ff3355', canvas: 'h', maxKbps: 51000,
    server: 'rtmp://a.rtmp.youtube.com/live2',
    servers: ['rtmp://a.rtmp.youtube.com/live2', 'rtmps://a.rtmps.youtube.com:443/live2', 'rtmp://b.rtmp.youtube.com/live2?backup=1'],
    keyUrl: 'https://studio.youtube.com/',
  },
  tiktok: {
    name: 'TikTok', color: '#25f4ee', canvas: 'v', maxKbps: 6000,
    server: '', servers: [],
    keyUrl: 'https://livecenter.tiktok.com/producer',
  },
  kick: {
    name: 'Kick', color: '#53fc18', canvas: 'h', maxKbps: 8000,
    server: '', servers: [],
    keyUrl: 'https://kick.com/dashboard/settings/stream',
  },
  facebook: {
    name: 'Facebook', color: '#1877f2', canvas: 'h', maxKbps: 8000,
    server: 'rtmps://live-api-s.facebook.com:443/rtmp/', servers: ['rtmps://live-api-s.facebook.com:443/rtmp/'],
    keyUrl: 'https://www.facebook.com/live/producer',
  },
  custom: {
    name: 'Custom RTMP', color: '#8b93b8', canvas: 'h', maxKbps: 100000,
    server: 'rtmp://', servers: [], keyUrl: '',
  },
};

export const DEFAULT_PRIVACY_KEYWORDS = [
  '1Password', 'Bitwarden', 'KeePass', 'LastPass', 'Dashlane', 'Proton Pass', 'Password', 'Passwort', 'Kennwort',
  'Online-Banking', 'Banking', 'Sparkasse', 'PayPal', 'Gmail', 'Outlook', 'WhatsApp', 'Signal', 'Telegram', 'Credential',
];

export function defaultSettings() {
  return {
    language: 'en',
    highPerformanceGpu: true,
    ffmpegPath: '',
    rtmpEngine: 'native',
    video: {
      h: { width: 1920, height: 1080, fps: 60, kbps: 6000 },
      v: { enabled: true, width: 1080, height: 1920, fps: 30, kbps: 4000 },
      encoder: 'auto',
      adaptive: true,
    },
    audio: { kbps: 160, syncOffsetMs: 0 },
    recording: { folder: '', remux: true, vertical: false },
    replay: { seconds: 30, autoStart: true },
    hype: { enabled: true, sensitivity: 3, cooldown: 90 },
    privacy: { enabled: true, keywords: DEFAULT_PRIVACY_KEYWORDS.slice(), message: 'Privacy mode · be right back', windows: false },
    transition: { type: 'luma', ms: 550 },
    countdown: 3,
    confirmEnd: true,
    safeZones: true,
    snap: true,
    hotkeys: { clip: 'Ctrl+Shift+F9', marker: 'Ctrl+Shift+F10', privacy: 'Ctrl+Shift+F11', muteMic: 'Ctrl+Shift+F12', goLive: '', record: '' },
    chat: { twitch: '', youtube: '' },
    onboarded: false,
  };
}

export function defaultAudioInputs() {
  return [
    { id: 'desktop', kind: 'desktop', name: 'Desktop Audio', enabled: true, volume: 0.8, muted: false, monitor: false, gate: { enabled: false, threshold: -60 }, compressor: false },
    { id: 'mic', kind: 'mic', name: 'Microphone', deviceId: 'default', enabled: true, volume: 1, muted: false, monitor: false, noiseSuppression: true, gate: { enabled: true, threshold: -48 }, compressor: true },
  ];
}

export let state = null;

export const rt = {
  live: false,
  liveStart: 0,
  recording: false,
  recStart: 0,
  replay: false,
  engine: false,
  selection: null, // item id
  editCanvas: 'h',
  privacy: { active: false, manual: false, reason: '' },
  outputs: {}, // id -> { status, error, kbps, ... }
  chatStatus: {},
  stats: null,
  info: null,
  markers: [],
  clips: [],
  focus: null,
};

function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadState(data) {
  const d = data || {};
  state = {
    version: 1,
    settings: merge(defaultSettings(), d.settings),
    audioInputs: d.audioInputs && d.audioInputs.length ? d.audioInputs : defaultAudioInputs(),
    destinations: d.destinations || [],
    sources: d.sources || {},
    scenes: d.scenes || [],
    activeSceneId: d.activeSceneId || null,
    rules: d.rules || [],
  };
  for (const scene of state.scenes) for (const item of scene.items) ensureLayouts(item);
  if (!state.scenes.find((s) => s.id === state.activeSceneId)) state.activeSceneId = state.scenes[0] ? state.scenes[0].id : null;
  return state;
}

const persist = debounce(() => {
  window.lc.invoke('state:save', state).catch((e) => console.error('save failed', e));
}, 500);

export function commit(topic, payload) {
  bus.emit(topic, payload);
  bus.emit('change', topic);
  persist();
}

export const flushSave = () => persist.flush();

// ---- lookups ---------------------------------------------------------------
export const getScene = (id) => state.scenes.find((s) => s.id === id) || null;
export const activeScene = () => getScene(state.activeSceneId);
export const getSource = (id) => state.sources[id] || null;

export function findItem(itemId, scene = activeScene()) {
  if (!scene) return null;
  return scene.items.find((i) => i.id === itemId) || null;
}

export function canvasSize(key) {
  const v = state.settings.video;
  return key === 'v' ? { w: v.v.width, h: v.v.height } : { w: v.h.width, h: v.h.height };
}

export const verticalEnabled = () => !!state.settings.video.v.enabled;

// ---- layout helpers ----------------------------------------------------------
export function makeLayout(x = 0, y = 0, w = 100, h = 100, extra = {}) {
  return { x, y, w, h, rot: 0, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 }, show: true, ...extra };
}

function ensureLayouts(item) {
  for (const k of ['h', 'v']) {
    if (!item[k]) item[k] = makeLayout(0, 0, 100, 100, { auto: true });
    if (!item[k].crop) item[k].crop = { l: 0, t: 0, r: 0, b: 0 };
  }
}

export function containRect(nw, nh, cw, ch, scale = 1) {
  const s = Math.min(cw / nw, ch / nh) * scale;
  const w = nw * s;
  const h = nh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

// Fills the region exactly by cropping the source (no overflow outside region).
export function coverRegion(nw, nh, rx, ry, rw, rh) {
  const s = Math.max(rw / nw, rh / nh);
  const vw = rw / s;
  const vh = rh / s;
  const cl = Math.max(0, (nw - vw) / 2);
  const ct = Math.max(0, (nh - vh) / 2);
  return { x: rx, y: ry, w: rw, h: rh, crop: { l: cl, r: cl, t: ct, b: ct } };
}

const BOXED = new Set(['chat', 'alerts', 'color']);

// Default placement per source type and canvas. `nat` is the raw source size.
export function autoLayout(type, nat, key) {
  const { w: W, h: H } = canvasSize(key);
  const vert = key === 'v';
  const L = (r) => makeLayout(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h), r.crop ? { crop: r.crop } : {});
  if (type === 'color') return L({ x: 0, y: 0, w: W, h: H });
  if (type === 'chat') return vert ? L({ x: W * 0.05, y: H * 0.5, w: W * 0.72, h: H * 0.3 }) : L({ x: W * 0.025, y: H * 0.3, w: W * 0.25, h: H * 0.62 });
  if (type === 'alerts') return vert ? L({ x: W * 0.05, y: H * 0.1, w: W * 0.9, h: H * 0.22 }) : L({ x: W * 0.2, y: H * 0.06, w: W * 0.6, h: H * 0.3 });
  if (!nat || !nat.w || !nat.h) return L({ x: W * 0.25, y: H * 0.25, w: W * 0.5, h: H * 0.5 });
  switch (type) {
    case 'display':
    case 'window':
    case 'media':
      return vert ? L(coverRegion(nat.w, nat.h, 0, 0, W, H)) : L(containRect(nat.w, nat.h, W, H));
    case 'camera': {
      if (vert) return L(coverRegion(nat.w, nat.h, 0, 0, W, Math.round(W * 0.62)));
      const w = W * 0.26;
      const h = (w * nat.h) / nat.w;
      return L({ x: W - w - W * 0.025, y: H - h - H * 0.04, w, h });
    }
    case 'avatar': {
      const size = vert ? W * 0.32 : H * 0.3;
      return vert ? L({ x: W * 0.04, y: H * 0.62, w: size, h: size }) : L({ x: W * 0.02, y: H - size - H * 0.03, w: size, h: size });
    }
    case 'browser':
      return nat.w >= W * 0.9 ? L({ x: 0, y: 0, w: W, h: (W * nat.h) / nat.w }) : L(containRect(nat.w, nat.h, W, H, Math.min(1, nat.w / W)));
    case 'text':
    case 'timer': {
      const s = Math.min(1, (W * 0.9) / nat.w);
      const w = nat.w * s;
      const h = nat.h * s;
      return L({ x: (W - w) / 2, y: vert ? H * 0.2 : (H - h) / 2, w, h });
    }
    case 'image':
    default:
      return L(containRect(nat.w, nat.h, W, H, 0.5));
  }
}

export const isBoxed = (type) => BOXED.has(type);

// ---- mutations -----------------------------------------------------------------
export function addSourceToScene(type, name, settings, sceneId = state.activeSceneId) {
  const src = { id: uid('src'), type, name, settings: settings || {} };
  state.sources[src.id] = src;
  const item = addItem(src.id, sceneId);
  return { src, item };
}

export function addItem(sourceId, sceneId = state.activeSceneId) {
  const scene = getScene(sceneId);
  const src = getSource(sourceId);
  if (!scene || !src) return null;
  const item = {
    id: uid('item'), sourceId, visible: true, locked: false,
    h: { ...autoLayout(src.type, null, 'h'), auto: !isBoxed(src.type) },
    v: { ...autoLayout(src.type, null, 'v'), auto: !isBoxed(src.type) },
  };
  scene.items.push(item);
  return item;
}

export function removeItem(sceneId, itemId) {
  const scene = getScene(sceneId);
  if (!scene) return;
  const idx = scene.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return;
  const [item] = scene.items.splice(idx, 1);
  const stillUsed = state.scenes.some((s) => s.items.some((i) => i.sourceId === item.sourceId));
  if (!stillUsed) delete state.sources[item.sourceId];
  if (rt.selection === itemId) rt.selection = null;
}

export function addScene(name, color) {
  const scene = { id: uid('scene'), name, color: color || '#7c5cff', items: [] };
  state.scenes.push(scene);
  return scene;
}

export function duplicateScene(id, name) {
  const s = getScene(id);
  if (!s) return null;
  const copy = deepClone(s);
  copy.id = uid('scene');
  copy.name = name;
  for (const it of copy.items) it.id = uid('item');
  state.scenes.splice(state.scenes.indexOf(s) + 1, 0, copy);
  return copy;
}

export function removeScene(id) {
  if (state.scenes.length <= 1) return false;
  const scene = getScene(id);
  if (!scene) return false;
  for (const it of [...scene.items]) removeItem(id, it.id);
  state.scenes = state.scenes.filter((s) => s.id !== id);
  if (state.activeSceneId === id) state.activeSceneId = state.scenes[0].id;
  return true;
}

// First-run studio: Starting Soon, Live and BRB scenes with a few sources.
export function createDefaultStudio(t) {
  const H = state.settings.video.h;
  const V = state.settings.video.v;
  const mk = (type, name, settings) => {
    const src = { id: uid('src'), type, name, settings };
    state.sources[src.id] = src;
    return src;
  };
  const item = (src, h, v, extra = {}) => ({ id: uid('item'), sourceId: src.id, visible: true, locked: false, h, v, ...extra });
  const full = (k) => makeLayout(0, 0, k === 'v' ? V.width : H.width, k === 'v' ? V.height : H.height);

  const bg = mk('color', t('Aurora background'), { mode: 'aurora', color: '#7c5cff', color2: '#00c2ff', angle: 135 });
  const title = mk('text', t('Title'), { text: t('Starting soon'), font: 'Segoe UI Variable Display', size: 120, weight: 800, color: '#ffffff', gradient: true, color2: '#b9c6ff', outline: 0, outlineColor: '#000000', shadow: true, bgOpacity: 0, align: 'center', anim: 'pulse' });
  const timer = mk('timer', t('Countdown'), { mode: 'countdown', minutes: 5, endText: t("We're live!"), restartOnShow: true, font: 'Segoe UI Variable Display', size: 84, weight: 600, color: '#e4e8ff', outline: 0, outlineColor: '#000000', shadow: true });
  const screenSrc = mk('display', t('Screen'), { sourceId: 'screen:0:0', displayId: '' });
  const chat = mk('chat', t('Chat overlay'), { fontSize: 26, max: 10, fade: 0, showPlatform: true, bg: 0.55 });
  const alerts = mk('alerts', t('Alerts'), { duration: 6, sound: true });
  const brb = mk('text', t('BRB text'), { text: t('Be right back'), font: 'Segoe UI Variable Display', size: 130, weight: 800, color: '#ffffff', gradient: true, color2: '#9fe8ff', shadow: true, bgOpacity: 0, align: 'center', anim: 'wave' });

  const at = (k, x, y, w, h) => makeLayout(x, y, w, h);
  const soon = {
    id: uid('scene'), name: t('Starting Soon'), color: '#22d3ee',
    items: [
      item(bg, full('h'), full('v')),
      item(title, { ...at('h', 0, 0, 10, 10), auto: true, yHint: 0.4 }, { ...at('v', 0, 0, 10, 10), auto: true, yHint: 0.32 }),
      item(timer, { ...at('h', 0, 0, 10, 10), auto: true, yHint: 0.66 }, { ...at('v', 0, 0, 10, 10), auto: true, yHint: 0.42 }),
    ],
  };
  const live = {
    id: uid('scene'), name: t('Live'), color: '#ff3d71',
    items: [
      item(screenSrc, { ...full('h'), auto: true }, { ...full('v'), auto: true }),
      item(chat, autoLayout('chat', null, 'h'), autoLayout('chat', null, 'v')),
      item(alerts, autoLayout('alerts', null, 'h'), autoLayout('alerts', null, 'v')),
    ],
  };
  const brbScene = {
    id: uid('scene'), name: t('Be Right Back'), color: '#a78bfa',
    items: [
      item(bg, full('h'), full('v')),
      item(brb, { ...at('h', 0, 0, 10, 10), auto: true, yHint: 0.5 }, { ...at('v', 0, 0, 10, 10), auto: true, yHint: 0.42 }),
    ],
  };
  state.scenes = [soon, live, brbScene];
  state.activeSceneId = live.id;
}
