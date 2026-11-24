// Main controls: Go Live (with countdown), Record, Replay buffer, Clip,
// Marker and Privacy Shield, plus the full-screen countdown overlay.
import { h, clear, fmtDuration, sleep } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, bus } from '../state.js';
import { app, registerPanel } from '../ctx.js';

const hk = (name) => {
  const k = state.settings.hotkeys[name];
  return k ? k.replace('Ctrl+Shift+', '⇧^').replace('Ctrl+', '^') : '';
};

export function mountControls(el) {
  let busy = false;
  let liveBtn;
  let recBtn;

  function render() {
    clear(el);
    liveBtn = h(`button.golive${rt.live ? '.live' : ''}${busy ? '.busy' : ''}`, { onClick: () => app.actions.toggleLive() });
    paintLive();
    recBtn = h(`button.btn.ctl${rt.recording ? '.rec-on' : ''}`, { onClick: () => app.actions.toggleRecord() },
      icon(rt.recording ? 'stop' : 'record', 15), h('span.rec-label', rt.recording ? fmtDuration(Date.now() - rt.recStart) : t('Record')), h('span.k', hk('record')));
    el.append(
      liveBtn,
      recBtn,
      h(`button.btn.ctl${rt.replay ? '.replay-on' : ''}`, { onClick: () => app.actions.toggleReplay(), title: t('Keeps the last {n} seconds in memory so you can clip moments', { n: state.settings.replay.seconds }) },
        icon('replay', 15), rt.replay ? t('Replay on') : t('Replay buffer')),
      h('button.btn.ctl', { disabled: !rt.replay, onClick: () => app.actions.saveClip(), title: t('Save the last {n} seconds as 16:9 and 9:16 clips', { n: state.settings.replay.seconds }) },
        icon('scissors', 15), t('Clip'), h('span.k', hk('clip'))),
      h('button.btn.ctl', { disabled: !(rt.live || rt.recording), onClick: () => app.actions.addMarker(), title: t('Drop a timestamp marker for editing later') },
        icon('flag', 15), t('Marker'), h('span.k', hk('marker'))),
      h(`button.btn.ctl${rt.privacy.active ? '.shield-on' : ''}`, { onClick: () => app.actions.togglePrivacy(), title: t('Instantly blur your screen captures') },
        icon(rt.privacy.active ? 'shieldOn' : 'shield', 15), rt.privacy.active ? t('Shield on') : t('Privacy'), h('span.k', hk('privacy'))),
    );
  }

  function paintLive() {
    if (!liveBtn) return;
    clear(liveBtn);
    liveBtn.className = `golive${rt.live ? ' live' : ''}${busy ? ' busy' : ''}`;
    if (busy) {
      liveBtn.append(h('span.spinner'), rt.live ? t('Ending…') : t('Connecting…'));
    } else if (rt.live) {
      const n = Object.values(rt.outputs).filter((o) => o.status === 'live').length;
      liveBtn.append(icon('stop', 18), h('div.stack', h('span', t('End stream')), h('span.sub', `${fmtDuration(Date.now() - rt.liveStart)} · ${t('{n} live', { n })}`)));
    } else {
      const n = state.destinations.filter((d) => d.enabled).length;
      liveBtn.append(icon('live', 20), h('div.stack', h('span', t('Go Live')), h('span.sub', n ? t('to {n} destinations', { n }) : t('add a destination first'))));
    }
  }

  function tick() {
    if (rt.live) paintLive();
    const lbl = recBtn && recBtn.querySelector('.rec-label');
    if (lbl && rt.recording) lbl.textContent = fmtDuration(Date.now() - rt.recStart);
  }

  function setBusy(b) {
    busy = b;
    paintLive();
  }

  setInterval(tick, 1000);
  for (const ev of ['runtime', 'destinations', 'settings']) bus.on(ev, render);
  bus.on('outputs', paintLive);
  render();
  return registerPanel({ render, setBusy });
}

// Full-screen 3-2-1 countdown. Resolves true when finished, false if cancelled.
export function countdown(seconds) {
  return new Promise((resolve) => {
    let cancelled = false;
    const num = h('div.num', String(seconds));
    const R = 150;
    const C = 2 * Math.PI * R;
    const ring = h('div', { html: `<svg class="ring" viewBox="0 0 320 320"><circle cx="160" cy="160" r="${R}" stroke="rgba(255,255,255,.08)"/><circle class="prog" cx="160" cy="160" r="${R}" stroke="url(#lcg)" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="0"/><defs><linearGradient id="lcg" x1="0" x2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs></svg>` });
    const overlay = h('div.countdown', ring.firstChild, num, h('div.label', t('Going live')),
      h('button.btn.cancel', { onClick: () => { cancelled = true; finish(); } }, t('Cancel')));
    document.body.append(overlay);
    const prog = overlay.querySelector('.prog');
    const start = performance.now();
    const total = seconds * 1000;
    const anim = (now) => {
      if (cancelled) return;
      const p = Math.min(1, (now - start) / total);
      prog.setAttribute('stroke-dashoffset', String(C * p));
      if (p < 1) requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
    let n = seconds;
    const step = async () => {
      while (n > 1 && !cancelled) {
        await sleep(1000);
        if (cancelled) return;
        n--;
        overlay.querySelector('.num').replaceWith(h('div.num', String(n)));
      }
      await sleep(1000);
      if (!cancelled) finish();
    };
    function finish() {
      overlay.classList.add('out');
      setTimeout(() => overlay.remove(), 350);
      resolve(!cancelled);
    }
    step();
  });
}
