'use strict';
// Read-only YouTube live chat without an API key, using the same endpoints the
// youtube.com popout chat uses. Best effort: YouTube can change these at any time.
const EventEmitter = require('events');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' };

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function videoIdFrom(target) {
  const t = target.trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  const m = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/.exec(t);
  return m ? m[1] : null;
}

function channelLiveUrl(target) {
  const t = target.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(t)) return `${t.replace(/\/(live|streams|featured|videos)$/i, '')}/live`;
  if (/^UC[\w-]{22}$/.test(t)) return `https://www.youtube.com/channel/${t}/live`;
  return `https://www.youtube.com/${t.startsWith('@') ? t : `@${t}`}/live`;
}

function runsToParts(runs) {
  const parts = [];
  for (const r of runs || []) {
    if (r.text !== undefined) parts.push({ type: 'text', text: r.text });
    else if (r.emoji) {
      const e = r.emoji;
      const thumbs = (e.image && e.image.thumbnails) || [];
      if (e.isCustomEmoji && thumbs.length) parts.push({ type: 'emote', name: (e.shortcuts || [])[0] || e.emojiId, url: thumbs[thumbs.length - 1].url });
      else parts.push({ type: 'text', text: e.emojiId || '' });
    }
  }
  return parts;
}

const partsText = (parts) => parts.map((p) => (p.type === 'text' ? p.text : p.name)).join('');

class YouTubeChat extends EventEmitter {
  constructor() {
    super();
    this.wanted = false;
    this.gen = 0;
  }

  start(target) {
    this.stop();
    this.target = String(target || '').trim();
    if (!this.target) return;
    this.wanted = true;
    this._run(++this.gen);
  }

  stop() {
    this.wanted = false;
    this.gen++;
    clearTimeout(this.timer);
    this._status('offline');
  }

  _status(state, error = '') {
    this.emit('status', { platform: 'youtube', state, error, channel: this.target });
  }

  _retry(gen, ms) {
    if (!this.wanted || gen !== this.gen) return;
    this.timer = setTimeout(() => this._run(gen), ms);
  }

  async _run(gen) {
    this._status('connecting');
    try {
      let videoId = videoIdFrom(this.target);
      if (!videoId) {
        const html = await fetchText(channelLiveUrl(this.target));
        const m = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(html);
        if (!m) {
          this._status('waiting', 'Channel is not live right now');
          return this._retry(gen, 30000);
        }
        videoId = m[1];
      }
      const page = await fetchText(`https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`);
      const apiKey = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(page) || [])[1];
      const clientVersion = (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(page) || /"clientVersion":"([^"]+)"/.exec(page) || [])[1];
      const dataMatch = /(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});\s*<\/script>/s.exec(page);
      if (!apiKey || !clientVersion || !dataMatch) throw new Error('Live chat not available for this stream');
      const data = JSON.parse(dataMatch[1]);
      const lcr = data.contents && data.contents.liveChatRenderer;
      if (!lcr) throw new Error('Live chat is disabled or the stream has ended');
      for (const a of lcr.actions || []) this._action(a, true);
      let continuation = this._continuation(lcr.continuations);
      if (!continuation) throw new Error('No chat continuation');
      this._status('connected');
      while (this.wanted && gen === this.gen) {
        const res = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}&prettyPrint=false`, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } }, continuation }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const lcc = json.continuationContents && json.continuationContents.liveChatContinuation;
        if (!lcc) {
          this._status('waiting', 'Stream ended');
          return this._retry(gen, 30000);
        }
        if (gen !== this.gen) return;
        for (const a of lcc.actions || []) this._action(a, false);
        const next = this._continuation(lcc.continuations, true);
        if (!next) throw new Error('Chat ended');
        continuation = next.continuation;
        await new Promise((r) => { this.timer = setTimeout(r, Math.min(8000, Math.max(1200, next.timeoutMs || 3000))); });
      }
    } catch (err) {
      if (gen !== this.gen) return;
      this._status('error', String(err.message || err));
      this._retry(gen, 20000);
    }
  }

  _continuation(list, withTimeout) {
    const c = (list || [])[0] || {};
    const d = c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData || c.liveChatReplayContinuationData;
    if (!d) return null;
    return withTimeout ? d : d.continuation;
  }

  _action(a, history) {
    if (a.addChatItemAction && a.addChatItemAction.item) {
      const item = a.addChatItemAction.item;
      const r = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer || item.liveChatMembershipItemRenderer || item.liveChatPaidStickerRenderer;
      if (!r) return;
      const user = (r.authorName && r.authorName.simpleText) || 'Someone';
      const parts = runsToParts((r.message || r.headerSubtext || {}).runs);
      const badges = (r.authorBadges || []).map((b) => {
        const br = b.liveChatAuthorBadgeRenderer || {};
        return br.icon ? String(br.icon.iconType).toLowerCase() : 'member';
      });
      const msg = {
        platform: 'youtube', id: r.id, user, userId: r.authorExternalChannelId, color: '', text: partsText(parts),
        parts, badges, history, ts: Date.now(),
      };
      if (item.liveChatPaidMessageRenderer || item.liveChatPaidStickerRenderer) {
        msg.paid = (r.purchaseAmountText && r.purchaseAmountText.simpleText) || '';
        if (!history) this.emit('event', { platform: 'youtube', type: 'superchat', user, amount: msg.paid, message: msg.text });
      } else if (item.liveChatMembershipItemRenderer) {
        msg.system = true;
        if (!msg.text) msg.text = `${user} became a member`;
        if (!msg.parts.length) msg.parts = [{ type: 'text', text: msg.text }];
        if (!history) this.emit('event', { platform: 'youtube', type: 'member', user, amount: 1, message: msg.text });
      }
      this.emit('message', msg);
    } else if (a.markChatItemAsDeletedAction) {
      this.emit('delete', { platform: 'youtube', id: a.markChatItemAsDeletedAction.targetItemId });
    } else if (a.removeChatItemAction) {
      this.emit('delete', { platform: 'youtube', id: a.removeChatItemAction.targetItemId });
    } else if (a.markChatItemsByAuthorAsDeletedAction) {
      this.emit('delete', { platform: 'youtube', userId: a.markChatItemsByAuthorAsDeletedAction.externalChannelId });
    }
  }
}

module.exports = { YouTubeChat };
