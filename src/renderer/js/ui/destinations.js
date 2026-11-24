// Destinations: Twitch / YouTube / TikTok / Kick / Facebook / custom RTMP,
// each bound to the 16:9 or 9:16 canvas, with live health + bitrate sparkline.
import { h, clear, uid } from '../util.js';
import { icon, PLATFORM_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, bus, commit, PLATFORMS, verticalEnabled } from '../state.js';
import { app, registerPanel } from '../ctx.js';
import { openModal, field, textInput, toggle, segmented, note, confirmDialog, toast } from './common.js';

const history = new Map(); // dest id -> kbps samples

export function mountDestinations(el) {
  const cards = new Map();

  function render() {
    clear(el);
    cards.clear();
    const body = h('div.card-body');
    el.append(
      h('div.card-head',
        h('div.card-title', t('Destinations'), h('span.count', `${state.destinations.filter((d) => d.enabled).length}/${state.destinations.length}`)),
        h('div.card-actions', h('button.btn.btn-sm', { onClick: () => editDestination(null) }, icon('plus', 14), t('Add')))),
      body,
    );
    if (!state.destinations.length) {
      body.append(h('div.empty', icon('live', 22), h('div', t('Stream to Twitch, YouTube and TikTok at the same time.')),
        h('button.btn.btn-sm.btn-primary', { style: { marginTop: '10px' }, onClick: () => editDestination(null) }, icon('plus', 14), t('Add destination'))));
      return;
    }
    state.destinations.forEach((d, i) => {
      const c = card(d, i);
      cards.set(d.id, c);
      body.append(c.el);
    });
    update();
  }

  function card(d, i) {
    const pf = PLATFORMS[d.platform] || PLATFORMS.custom;
    const status = h('span.status-dot');
    const sub = h('span.txt');
    const spark = h('canvas.spark', { width: 260, height: 44 });
    const vert = d.canvas === 'v' && verticalEnabled();
    const sw = toggle(d.enabled, async (v) => {
      d.enabled = v;
      commit('destinations');
      if (rt.live) {
        if (v) await app.output.restartDestination(d);
        else await app.output.stopDestination(d.id);
      }
      render();
    }, { title: t('Include in Go Live') });
    const elx = h(`div.dest${d.enabled ? '' : '.off'}`, { style: { '--i': i } },
      h('div.dest-glyph', { style: { background: `linear-gradient(135deg, ${pf.color}, ${shade(pf.color)})`, color: d.platform === 'tiktok' || d.platform === 'kick' ? '#0b0c14' : '#fff' } }, icon(PLATFORM_ICONS[d.platform] || 'pfCustom', 18)),
      h('div.dest-name', h('span', d.name), h(`span.tag${vert ? '.v' : ''}`, vert ? '9:16' : '16:9')),
      h('div.dest-actions', h('button.icon-btn', { title: t('Edit'), onClick: () => editDestination(d) }, icon('pencil', 14)), sw),
      h('div.dest-sub', status, sub),
      spark);
    return { el: elx, status, sub, spark, d };
  }

  function update() {
    const stats = rt.stats ? rt.stats.outputs : [];
    for (const [id, c] of cards) {
      const d = c.d;
      const o = rt.outputs[id] || {};
      const st = stats.find((s) => s.id === id);
      const streaming = rt.live && d.enabled;
      c.el.classList.toggle('streaming', !!streaming);
      let cls = '';
      let text;
      if (streaming) {
        const status = o.status || 'connecting';
        cls = status === 'live' ? 'live' : status === 'error' || status === 'offline' ? 'error' : status;
        if (status === 'live' && st) {
          text = `${t('Live')} · ${(st.kbps / 1000).toFixed(1)} Mbit/s${st.dropped ? ` · ${t('{n} dropped', { n: st.dropped })}` : ''}${st.queueMs > 800 ? ` · ${t('lagging')}` : ''}`;
        } else if (status === 'reconnecting') text = `${t('Reconnecting…')}${o.error ? ` (${o.error})` : ''}`;
        else if (status === 'connecting') text = t('Connecting…');
        else text = o.error || t('Stopped');
        if (st) {
          const arr = history.get(id) || [];
          arr.push(st.kbps);
          if (arr.length > 60) arr.shift();
          history.set(id, arr);
          drawSpark(c.spark, arr, (PLATFORMS[d.platform] || PLATFORMS.custom).color);
        }
      } else {
        history.delete(id);
        const hasKey = !!(d.key || '').trim() || d.platform === 'custom';
        cls = '';
        text = !d.server ? t('Server URL missing') : !hasKey ? t('Stream key missing') : hostOf(d.server);
        if (!d.server || !hasKey) cls = 'error';
      }
      c.status.className = `status-dot ${cls}`;
      c.sub.textContent = text;
      c.sub.title = text;
    }
  }

  bus.on('destinations', render);
  bus.on('settings', render);
  bus.on('outputs', update);
  bus.on('stats', update);
  bus.on('runtime', update);
  render();
  return registerPanel({ render });
}

function hostOf(url) {
  const m = /^[a-z]+:\/\/([^/:?]+)/i.exec(url || '');
  return m ? m[1] : url;
}

function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.round(v * 0.62));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawSpark(canvas, arr, color) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (arr.length < 2) return;
  const max = Math.max(1000, ...arr) * 1.15;
  const step = W / 59;
  const pts = arr.map((v, i) => [W - (arr.length - 1 - i) * step, H - (v / max) * (H - 4) - 2]);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `${color}55`);
  g.addColorStop(1, `${color}00`);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], H);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length - 1][0], H);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

const HELP = {
  twitch: 'Twitch: Creator Dashboard → Settings → Stream → copy the Primary Stream key.',
  youtube: 'YouTube: Studio → Go live → Stream. Copy the stream key; turn on Auto-start so the broadcast begins when Lumacast connects.',
  tiktok: 'TikTok: LIVE Center / LIVE Producer shows a Server URL and Stream key once your account has LIVE access. Keys change for every session.',
  kick: 'Kick: Dashboard → Settings → Stream URL & Key. Paste both here.',
  facebook: 'Facebook: Live Producer → Streaming software → copy the stream key.',
  custom: 'Any RTMP or RTMPS ingest (Restream, own server, etc.). The key is appended to the URL.',
};

export function editDestination(existing) {
  const d = existing ? { ...existing } : { id: uid('dest'), platform: 'twitch', name: 'Twitch', server: PLATFORMS.twitch.server, key: '', canvas: 'h', enabled: true };
  const body = h('div');
  const renderBody = () => {
    clear(body);
    const pf = PLATFORMS[d.platform];
    if (!existing) {
      body.append(h('div.type-grid', { style: { marginBottom: '10px', gridTemplateColumns: 'repeat(6, 1fr)' } },
        Object.entries(PLATFORMS).map(([id, p], i) => h(`button.type-card${d.platform === id ? '.on' : ''}`, {
          style: { '--i': i, alignItems: 'center', padding: '10px 6px', borderColor: d.platform === id ? p.color : '' },
          onClick: () => {
            d.platform = id;
            d.name = p.name;
            d.server = p.server;
            d.canvas = p.canvas === 'v' && verticalEnabled() ? 'v' : 'h';
            renderBody();
          },
        }, h('span.ic', { style: { background: `${p.color}26`, color: p.color } }, icon(PLATFORM_ICONS[id], 18)), h('b', { style: { fontSize: '11.5px' } }, p.name)))));
    }
    body.append(field(t('Name'), textInput(d.name, (v) => { d.name = v; })));
    const serverInput = textInput(d.server, (v) => { d.server = v.trim(); }, { mono: true, placeholder: 'rtmp://…' });
    if (pf.servers.length > 1) {
      const dl = h('datalist', { id: `servers-${d.platform}` }, pf.servers.map((s) => h('option', { value: s })));
      serverInput.setAttribute('list', dl.id);
      body.append(dl);
    }
    body.append(field(t('Server'), serverInput, pf.servers.length > 1 ? t('Pick a suggestion or paste your own ingest URL.') : null));
    const keyInput = textInput(d.key, (v) => { d.key = v.trim(); }, { type: 'password', mono: true, placeholder: t('Paste your stream key') });
    const eye = h('button.icon-btn', { title: t('Show / hide'), onClick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, icon('eye', 15));
    const getKey = pf.keyUrl ? h('button.btn.btn-sm', { onClick: () => window.lc.invoke('shell:external', pf.keyUrl) }, icon('external', 13), t('Get key')) : null;
    body.append(field(t('Stream key'), h('div.ctrl', { style: { flex: 1 } }, keyInput, eye, getKey), t('Stored encrypted on this PC (Windows DPAPI). Never shared.')));
    const canvasSeg = segmented(d.canvas, [
      { value: 'h', icon: 'tv', label: t('16:9 landscape') },
      { value: 'v', icon: 'phone', label: t('9:16 vertical') },
    ], (v) => { d.canvas = v; });
    body.append(field(t('Canvas'), canvasSeg, !verticalEnabled() ? t('The 9:16 canvas is off; this destination will use 16:9 until you turn on Dual canvas.') : null));
    const kbps = state.settings.video[d.canvas === 'v' ? 'v' : 'h'].kbps;
    if (kbps > pf.maxKbps) body.append(note(t('{p} recommends at most {max} kbps; your canvas is set to {kbps} kbps. Lower it in Settings → Video if viewers buffer.', { p: pf.name, max: pf.maxKbps, kbps }), 'warn'));
    body.append(h('div', { style: { height: '8px' } }), note(t(HELP[d.platform])));
  };
  renderBody();
  const left = existing ? [h('button.btn.btn-danger', { onClick: async () => {
    if (!(await confirmDialog(t('Remove destination?'), d.name, { ok: t('Remove'), danger: true }))) return;
    if (rt.live) await app.output.stopDestination(d.id);
    state.destinations = state.destinations.filter((x) => x.id !== d.id);
    commit('destinations');
    m.close();
  } }, icon('trash', 14), t('Remove'))] : [];
  const m = openModal({
    title: existing ? t('Edit destination') : t('Add destination'),
    width: 640,
    body,
    left,
    actions: [
      h('button.btn.btn-ghost', { onClick: () => m.close() }, t('Cancel')),
      h('button.btn.btn-primary', { onClick: async () => {
        if (!d.server) { toast(t('Server URL missing'), { type: 'warn' }); return; }
        if (!/^rtmps?:\/\//i.test(d.server)) { toast(t('The server must start with rtmp:// or rtmps://'), { type: 'warn' }); return; }
        if (existing) {
          Object.assign(existing, d);
          if (rt.live && d.enabled) await app.output.restartDestination(existing);
        } else state.destinations.push(d);
        commit('destinations');
        m.close();
        toast(existing ? t('Destination saved') : t('{name} added', { name: d.name }), { type: 'ok' });
      } }, icon('check', 14), t('Save')),
    ],
  });
}
