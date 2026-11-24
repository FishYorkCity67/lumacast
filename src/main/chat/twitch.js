'use strict';
// Read-only Twitch chat over anonymous IRC (no login needed). Also surfaces
// subs, gifts, raids and cheers from USERNOTICE / bits tags for on-stream alerts.
const net = require('net');
const EventEmitter = require('events');

const ESCAPES = { s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' };

function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    tags[k] = v.replace(/\\(.)/g, (_, c) => ESCAPES[c] ?? c);
  }
  return tags;
}

function parseLine(line) {
  let rest = line;
  let tags = {};
  if (rest[0] === '@') {
    const sp = rest.indexOf(' ');
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest[0] === ':') {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing = null;
  const ti = rest.indexOf(' :');
  if (ti >= 0) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }
  const [command, ...params] = rest.split(' ').filter(Boolean);
  if (trailing !== null) params.push(trailing);
  return { tags, prefix, command, params };
}

function buildParts(text, emotes) {
  const chars = Array.from(text);
  const ranges = [];
  if (emotes) {
    for (const group of emotes.split('/')) {
      const [id, positions] = group.split(':');
      for (const p of (positions || '').split(',')) {
        const [s, e] = p.split('-').map(Number);
        if (Number.isFinite(s) && Number.isFinite(e)) ranges.push({ s, e, id });
      }
    }
  }
  ranges.sort((a, b) => a.s - b.s);
  const parts = [];
  let i = 0;
  for (const r of ranges) {
    if (r.s < i) continue;
    if (r.s > i) parts.push({ type: 'text', text: chars.slice(i, r.s).join('') });
    parts.push({ type: 'emote', name: chars.slice(r.s, r.e + 1).join(''), url: `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/2.0` });
    i = r.e + 1;
  }
  if (i < chars.length) parts.push({ type: 'text', text: chars.slice(i).join('') });
  return parts;
}

class TwitchChat extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.channel = '';
    this.wanted = false;
    this.attempt = 0;
  }

  start(channel) {
    this.stop();
    this.channel = String(channel || '').trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?]/)[0].toLowerCase();
    if (!this.channel) return;
    this.wanted = true;
    this.attempt = 0;
    this._connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this._status('offline');
  }

  _status(state, error = '') {
    this.emit('status', { platform: 'twitch', state, error, channel: this.channel });
  }

  _connect() {
    this._status('connecting');
    const sock = net.connect({ host: 'irc.chat.twitch.tv', port: 6667 });
    this.socket = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 60000);
    sock.on('connect', () => {
      const nick = `justinfan${Math.floor(10000 + Math.random() * 80000)}`;
      sock.write('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
      sock.write('PASS SCHMOOPIIE\r\n');
      sock.write(`NICK ${nick}\r\n`);
      sock.write(`JOIN #${this.channel}\r\n`);
    });
    sock.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) if (line) this._handle(parseLine(line));
    });
    const onEnd = (err) => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (!this.wanted) return;
      const delay = Math.min(30000, 1500 * 2 ** Math.min(this.attempt++, 4));
      this._status('reconnecting', err ? String(err.message || err) : '');
      this.retry = setTimeout(() => this.wanted && this._connect(), delay);
    };
    sock.on('error', onEnd);
    sock.on('close', () => onEnd());
  }

  _handle(m) {
    const { tags, command, params, prefix } = m;
    switch (command) {
      case 'PING':
        if (this.socket) this.socket.write(`PONG :${params[0] || 'tmi.twitch.tv'}\r\n`);
        break;
      case 'ROOMSTATE':
        this.attempt = 0;
        this._status('connected');
        break;
      case 'RECONNECT':
        if (this.socket) this.socket.destroy();
        break;
      case 'NOTICE':
        if (/suspended|does not exist|banned/i.test(params[1] || '')) this._status('error', params[1]);
        break;
      case 'PRIVMSG': {
        let text = params[1] || '';
        let action = false;
        if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) {
          text = text.slice(8, -1);
          action = true;
        }
        const login = prefix.split('!')[0];
        const msg = {
          platform: 'twitch', id: tags.id || `${Date.now()}${Math.random()}`, user: tags['display-name'] || login,
          login, color: tags.color || '', text, action, parts: buildParts(text, tags.emotes),
          badges: (tags.badges || '').split(',').filter(Boolean).map((b) => b.split('/')[0]),
          bits: Number(tags.bits) || 0, ts: Date.now(),
        };
        this.emit('message', msg);
        if (msg.bits > 0) this.emit('event', { platform: 'twitch', type: 'cheer', user: msg.user, amount: msg.bits, message: text });
        break;
      }
      case 'USERNOTICE': {
        const id = tags['msg-id'];
        const user = tags['display-name'] || tags.login || 'Someone';
        const message = params[1] || '';
        const system = tags['system-msg'] || '';
        if (system) this.emit('message', { platform: 'twitch', id: tags.id || String(Date.now()), system: true, user, text: system, parts: [{ type: 'text', text: system }], badges: [], ts: Date.now() });
        if (id === 'sub' || id === 'resub') this.emit('event', { platform: 'twitch', type: 'sub', user, amount: Number(tags['msg-param-cumulative-months']) || 1, message });
        else if (id === 'subgift') this.emit('event', { platform: 'twitch', type: 'gift', user, amount: 1, message: tags['msg-param-recipient-display-name'] || '' });
        else if (id === 'submysterygift') this.emit('event', { platform: 'twitch', type: 'gift', user, amount: Number(tags['msg-param-mass-gift-count']) || 1, message: '' });
        else if (id === 'raid') this.emit('event', { platform: 'twitch', type: 'raid', user: tags['msg-param-displayName'] || user, amount: Number(tags['msg-param-viewerCount']) || 0, message: '' });
        break;
      }
      case 'CLEARCHAT':
        this.emit('delete', { platform: 'twitch', login: params[1] || null, all: !params[1] });
        break;
      case 'CLEARMSG':
        this.emit('delete', { platform: 'twitch', id: tags['target-msg-id'] });
        break;
      default:
        break;
    }
  }
}

module.exports = { TwitchChat, parseLine, buildParts };
