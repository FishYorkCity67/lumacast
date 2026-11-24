// Privacy Shield (auto-blur on sensitive windows), auto-scene rules and
// stream markers.
import { Emitter, fmtDuration } from './util.js';
import { state, rt, getScene } from './state.js';

export class Automation extends Emitter {
  constructor(compositor, audio) {
    super();
    this.compositor = compositor;
    this.audio = audio;
    this.autoShield = false;
    this.autoReason = '';
    this.windowRule = null;
    this.lastVoice = performance.now();
    this.silenceFired = {};
    window.lc.on('winwatch:focus', (f) => this.onFocus(f));
    setInterval(() => this.tick(), 1000);
  }

  async apply() {
    const need = state.settings.privacy.enabled || state.rules.some((r) => r.enabled && r.when.type === 'window');
    const cur = await window.lc.invoke('winwatch:set', need);
    if (cur && cur.process) this.onFocus(cur);
    this.evalPrivacy();
  }

  onFocus(f) {
    rt.focus = f;
    this.emit('focus', f);
    if (f.own) return; // keep the current state while the user works in Lumacast
    const p = state.settings.privacy;
    const hay = `${f.process} ${f.title}`.toLowerCase();
    const kw = p.enabled ? p.keywords.find((k) => k && hay.includes(k.toLowerCase())) : null;
    this.autoShield = !!kw;
    this.autoReason = kw ? `${f.process || f.title}` : '';
    this.evalPrivacy();
    this.evalWindowRules(hay);
  }

  evalPrivacy() {
    if (!state.settings.privacy.enabled) this.autoShield = false;
    const active = rt.privacy.manual || this.autoShield;
    const reason = rt.privacy.manual ? 'manual' : this.autoReason;
    if (active !== rt.privacy.active || reason !== rt.privacy.reason) {
      rt.privacy.active = active;
      rt.privacy.reason = reason;
      this.compositor.setPrivacy(active);
      this.emit('privacy', { ...rt.privacy });
    }
  }

  togglePrivacy(force) {
    rt.privacy.manual = force === undefined ? !rt.privacy.manual : force;
    if (!rt.privacy.manual) this.autoShield = false;
    this.evalPrivacy();
  }

  evalWindowRules(hay) {
    for (const r of state.rules) {
      if (!r.enabled || r.when.type !== 'window' || !r.when.match) continue;
      const hit = hay.includes(r.when.match.toLowerCase());
      if (hit && this.windowRule !== r.id) {
        this.windowRule = r.id;
        this.fire(r);
        return;
      }
      if (!hit && this.windowRule === r.id) this.windowRule = null;
    }
  }

  fire(rule) {
    if (!getScene(rule.scene) || rule.scene === state.activeSceneId) return;
    rule._prev = state.activeSceneId;
    this.compositor.switchTo(rule.scene);
    this.emit('rule', rule);
  }

  tick() {
    const now = performance.now();
    if (this.audio.level('mic') > -50) this.lastVoice = now;
    for (const r of state.rules) {
      if (!r.enabled || r.when.type !== 'silence') continue;
      const silent = now - this.lastVoice > (r.when.minutes || 3) * 60000;
      if (silent && !this.silenceFired[r.id] && rt.live) {
        this.silenceFired[r.id] = true;
        this.fire(r);
      } else if (!silent && this.silenceFired[r.id]) {
        this.silenceFired[r.id] = false;
        if (r.returnBack && r._prev && state.activeSceneId === r.scene) this.compositor.switchTo(r._prev);
      }
    }
  }

  // ---- markers ------------------------------------------------------------------------
  addMarker(label) {
    const base = rt.live ? rt.liveStart : rt.recording ? rt.recStart : 0;
    if (!base) return null;
    const m = { t: Date.now() - base, label: label || 'Marker', at: Date.now() };
    rt.markers.push(m);
    this.emit('marker', m);
    return m;
  }

  markersText(title) {
    const lines = [`${title}`, `${new Date().toLocaleString()}`, ''];
    for (const m of rt.markers) lines.push(`${fmtDuration(m.t)}  ${m.label}`);
    return lines.join('\r\n');
  }
}
