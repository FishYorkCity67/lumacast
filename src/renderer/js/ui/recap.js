// Post-stream recap and the first-run welcome.
import { h, fmtDuration, fmtBytes, countUp } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, PLATFORMS } from '../state.js';
import { openModal } from './common.js';

export function showRecap(summary) {
  const { duration, outputs, session, markers, clips, markersFile } = summary;
  const bytes = outputs.reduce((a, o) => a + (o.bytes || 0), 0);
  const dropped = outputs.reduce((a, o) => a + (o.dropped || 0), 0);
  const stats = [
    [t('Duration'), fmtDuration(duration), null],
    [t('Chat messages'), session.messages, session.messages],
    [t('Peak chat / min'), Math.round(session.peakPerMin), Math.round(session.peakPerMin)],
    [t('Chatters'), session.chatters.size, session.chatters.size],
    [t('Clips'), clips.length, clips.length],
    [t('Markers'), markers.length, markers.length],
    [t('Data sent'), fmtBytes(bytes), null],
    [t('Dropped frames'), dropped, dropped],
  ];
  const statEls = stats.map(([l, v, n], i) => {
    const vEl = h('div.v', String(v));
    if (typeof n === 'number' && n > 0) countUp(vEl, n);
    return h('div.stat', { style: { '--i': i } }, vEl, h('div.l', l));
  });
  const events = session.events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  const evText = Object.entries(events).map(([k, n]) => `${n}× ${k}`).join(' · ');
  const list = h('div.recap-list');
  let i = 0;
  for (const o of outputs.filter((x) => x.kind === 'rtmp')) {
    const d = state.destinations.find((x) => x.id === o.id);
    const pf = PLATFORMS[d ? d.platform : 'custom'] || PLATFORMS.custom;
    list.append(h('div.r', { style: { '--i': i++ } }, h('span.status-dot', { style: { background: pf.color } }), h('span.grow', o.name),
      h('span.muted', `${fmtBytes(o.bytes)} · ${o.reconnects ? t('{n} reconnects', { n: o.reconnects }) : t('stable')}${o.dropped ? ` · ${t('{n} dropped', { n: o.dropped })}` : ''}`)));
  }
  for (const m of markers) list.append(h('div.r', { style: { '--i': i++ } }, icon('flag', 14), h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, fmtDuration(m.t)), h('span.grow', m.label)));
  for (const c of clips) {
    list.append(h('div.r', { style: { '--i': i++ } }, icon('scissors', 14), h('span.grow', c.file.split(/[\\/]/).pop()),
      h('button.btn.btn-sm', { onClick: () => window.lc.invoke('shell:reveal', c.file) }, t('Show'))));
  }
  const folder = state.settings.recording.folder || rt.info.videosDir;
  const m = openModal({
    title: t('Stream recap'),
    width: 720,
    body: h('div',
      h('div.recap-hero', h('div.big', t('GG!')), h('div.sub', evText || t('Thanks for streaming with Lumacast.'))),
      h('div.stats-grid', statEls),
      list),
    left: [
      h('button.btn', { onClick: () => window.lc.invoke('shell:open', folder) }, icon('folder', 14), t('Open videos folder')),
      markersFile ? h('button.btn', { onClick: () => window.lc.invoke('shell:reveal', markersFile) }, icon('flag', 14), t('Markers file')) : null,
    ],
    actions: [h('button.btn.btn-primary', { onClick: () => m.close() }, t('Close'))],
  });
}

const FEATURES = [
  ['live', 'Multistream', 'Twitch, YouTube, TikTok and more at once — each with auto-reconnect.'],
  ['phone', 'Dual canvas', 'A real 9:16 stream for TikTok next to your 16:9 one, from the same scenes.'],
  ['shield', 'Privacy Shield', 'Blurs your screen the moment a password manager or banking tab gets focus.'],
  ['zap', 'Hype clips', 'Chat explodes? The last 30 s are saved as 16:9 + 9:16 clips automatically.'],
  ['chat', 'Unified chat & alerts', 'Twitch + YouTube chat in one feed and on stream, with built-in alerts.'],
  ['smile', 'Voice avatar', 'A PNGtuber that reacts to your mic — no extra app needed.'],
];

export function showWelcome(onStart) {
  const m = openModal({
    title: '',
    width: 720,
    body: h('div',
      h('div.welcome-hero',
        h('div.brand-mark', { style: { margin: '0 auto', width: '54px', height: '54px', borderRadius: '17px' } }),
        h('h1', t('Welcome to Lumacast')),
        h('p', t('Your studio is ready: a Starting Soon, Live and BRB scene with chat overlay and alerts. Add where you want to stream and go live.'))),
      h('div.feature-grid', FEATURES.map(([ic, title, text], i) => h('div.feature', { style: { '--i': i } }, icon(ic, 16), h('div', h('b', t(title)), h('span', t(text))))))),
    left: [h('button.btn.btn-ghost', { onClick: () => m.close() }, t('Explore first'))],
    actions: [h('button.btn.btn-primary', { onClick: () => { m.close(); onStart(); } }, icon('plus', 14), t('Add destinations'))],
  });
}
