// Unified chat (Twitch + YouTube), moderation deletes, stream events and the
// chat-velocity "hype" detector that triggers automatic clips.
import { Emitter, hashColor, clamp } from './util.js';
import { state, rt } from './state.js';

export class ChatHub extends Emitter {
  constructor() {
    super();
    this.messages = [];
    this.times = [];
    this.baseline = null;
    this.lastHype = 0;
    this.hypeLevel = 0;
    this.resetSession();
    window.lc.on('chat:message', (m) => this.add(m));
    window.lc.on('chat:delete', (d) => this.remove(d));
    window.lc.on('chat:event', (ev) => this.event(ev));
    window.lc.on('chat:status', (s) => {
      rt.chatStatus[s.platform] = s;
      this.emit('status', s);
    });
    setInterval(() => this.hypeTick(), 1000);
  }

  resetSession() {
    this.session = { messages: 0, peakPerMin: 0, events: [], chatters: new Set() };
  }

  connect() {
    const c = state.settings.chat;
    return window.lc.invoke('chat:connect', { twitch: c.twitch, youtube: c.youtube });
  }

  add(m) {
    m.at = performance.now();
    if (!m.color) m.color = hashColor(m.user || '?');
    this.messages.push(m);
    if (this.messages.length > 400) this.messages.splice(0, this.messages.length - 300);
    if (!m.history && !m.system) {
      this.times.push(Date.now());
      if (rt.live) {
        this.session.messages++;
        this.session.chatters.add(`${m.platform}:${m.user}`);
      }
    }
    this.emit('message', m);
  }

  remove(d) {
    for (const m of this.messages) {
      if (m.platform !== d.platform) continue;
      if (d.all || (d.id && m.id === d.id) || (d.login && m.login === d.login) || (d.userId && m.userId === d.userId)) m.deleted = true;
    }
    this.emit('delete', d);
  }

  event(ev) {
    if (rt.live) this.session.events.push({ ...ev, at: Date.now() });
    this.emit('event', ev);
  }

  rate10() {
    const cut = Date.now() - 10000;
    while (this.times.length && this.times[0] < cut) this.times.shift();
    return this.times.length;
  }

  hypeTick() {
    const r = this.rate10();
    this.baseline = this.baseline === null ? r : this.baseline * 0.985 + r * 0.015;
    const perMin = r * 6;
    if (rt.live && perMin > this.session.peakPerMin) this.session.peakPerMin = perMin;
    const h = state.settings.hype;
    const sens = clamp(Math.round(h.sensitivity || 3), 1, 5);
    const k = [4, 3, 2.5, 2, 1.6][sens - 1];
    const minRate = [14, 10, 7, 5, 3][sens - 1];
    const threshold = Math.max(minRate, this.baseline * k);
    this.hypeLevel = clamp(r / threshold, 0, 1.5);
    this.emit('rate', { perMin, level: this.hypeLevel });
    if (h.enabled && r >= threshold && Date.now() - this.lastHype > (h.cooldown || 90) * 1000) {
      this.lastHype = Date.now();
      this.emit('hype', { perMin });
    }
  }
}
