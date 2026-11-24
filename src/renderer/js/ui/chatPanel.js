// Unified chat panel: Twitch + YouTube in one feed, platform filter, hype
// meter, moderation-aware (deleted messages are struck through) and pop-outs.
import { h, clear } from '../util.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { state, rt, bus, commit, PLATFORMS } from '../state.js';
import { app, registerPanel } from '../ctx.js';
import { segmented, openModal, field, textInput, note, contextMenu, toast } from './common.js';

export function mountChat(el) {
  let list;
  let filter = 'all';
  let stick = true;
  let newPill;
  let hypeFill;
  let hypeWrap;
  let rateEl;
  let statusRow;

  function render() {
    clear(el);
    list = h('div.chat-list');
    newPill = h('button.btn.btn-sm.btn-primary.new-msgs', { onClick: () => { stick = true; list.scrollTop = list.scrollHeight; newPill.classList.remove('show'); } }, icon('down', 13), t('New messages'));
    hypeFill = h('div.fill');
    hypeWrap = h('div.hype', hypeFill);
    rateEl = h('span.rate', '0/min');
    statusRow = h('div.chat-status');
    el.append(
      h('div.card-head',
        h('div.card-title', t('Chat')),
        segmented(filter, [{ value: 'all', label: t('All') }, { value: 'twitch', label: 'Twitch' }, { value: 'youtube', label: 'YouTube' }], (v) => { filter = v; fill(); }),
        h('div.card-actions',
          h('button.icon-btn', { title: t('Open chat to reply (pop-out)'), onClick: (e) => popMenu(e) }, icon('external', 15)),
          h('button.icon-btn', { title: t('Chat settings'), onClick: settings }, icon('settings', 15)))),
      statusRow,
      h('div.hype-row', icon('zap', 12), t('Chat hype'), rateEl),
      hypeWrap,
      h('div.chat-wrap', { style: { position: 'relative' } }, list, newPill),
    );
    list.addEventListener('scroll', () => {
      stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      if (stick) newPill.classList.remove('show');
    });
    renderStatus();
    fill();
  }

  function renderStatus() {
    clear(statusRow);
    const c = state.settings.chat;
    if (!c.twitch && !c.youtube) {
      statusRow.append(h('button.chip', { onClick: settings }, icon('plus', 12), t('Connect your chats')));
      return;
    }
    for (const p of ['twitch', 'youtube']) {
      if (!c[p]) continue;
      const s = rt.chatStatus[p] || {};
      const cls = s.state === 'connected' ? 'live' : s.state === 'error' ? 'error' : s.state === 'waiting' ? '' : 'connecting';
      statusRow.append(h('span.chip', { title: s.error || '', onClick: settings },
        h(`span.status-dot.${cls}`), PLATFORMS[p].name,
        h('span.muted', s.state === 'connected' ? c[p] : s.state === 'waiting' ? t('not live yet') : s.state === 'error' ? t('error') : t('connecting'))));
    }
  }

  function visible(m) {
    return filter === 'all' || m.platform === filter;
  }

  function msgEl(m) {
    const pc = (PLATFORMS[m.platform] || PLATFORMS.custom).color;
    const parts = (m.parts || [{ type: 'text', text: m.text }]).map((p) => (p.type === 'emote'
      ? h('img.emote', { src: p.url, alt: p.name, title: p.name, referrerPolicy: 'no-referrer' })
      : document.createTextNode(p.text)));
    const badges = (m.badges || []).filter((b) => ['moderator', 'mod', 'broadcaster', 'owner', 'vip', 'subscriber', 'member', 'verified'].includes(b)).slice(0, 2)
      .map((b) => h(`span.bdg.${b === 'moderator' ? 'mod' : b}`, b === 'moderator' ? 'mod' : b === 'subscriber' ? 'sub' : b));
    return h(`div.msg${m.system ? '.system' : ''}${m.paid ? '.paid' : ''}${m.deleted ? '.deleted' : ''}`, { style: { '--pc': pc }, dataset: { id: m.id } },
      badges,
      m.system ? null : h('span.name', { style: { color: m.color } }, m.user),
      m.paid ? h('b', { style: { marginRight: '6px', color: '#ffd166' } }, m.paid) : null,
      parts);
  }

  function fill() {
    clear(list);
    const msgs = app.chat.messages.filter(visible).slice(-150);
    if (!msgs.length) {
      list.append(h('div.empty', icon('chat', 22), h('div', t('Messages from Twitch and YouTube appear here — and on stream with the Chat overlay source.'))));
    }
    for (const m of msgs) list.append(msgEl(m));
    list.scrollTop = list.scrollHeight;
  }

  function onMessage(m) {
    if (!list || !visible(m)) return;
    const empty = list.querySelector('.empty');
    if (empty) empty.remove();
    list.append(msgEl(m));
    while (list.children.length > 200) list.firstChild.remove();
    if (stick) list.scrollTop = list.scrollHeight;
    else newPill.classList.add('show');
  }

  function onDelete() {
    if (!list) return;
    for (const node of list.querySelectorAll('.msg')) {
      const m = app.chat.messages.find((x) => x.id === node.dataset.id);
      if (m && m.deleted) node.classList.add('deleted');
    }
  }

  function popMenu(e) {
    const b = e.currentTarget.getBoundingClientRect();
    const c = state.settings.chat;
    contextMenu(b.left - 120, b.bottom + 6, [
      { title: t('Reply in a pop-out window') },
      { label: 'Twitch', icon: 'pfTwitch', disabled: !c.twitch, onClick: () => window.lc.invoke('chat:popout', PLATFORMS.twitch.chatUrl(c.twitch.replace(/^.*twitch\.tv\//i, ''))) },
      { label: 'YouTube Studio', icon: 'pfYoutube', onClick: () => window.lc.invoke('chat:popout', 'https://studio.youtube.com/') },
      { label: 'TikTok LIVE Center', icon: 'pfTiktok', onClick: () => window.lc.invoke('chat:popout', 'https://livecenter.tiktok.com/') },
    ]);
  }

  function settings() {
    const c = { ...state.settings.chat };
    const body = h('div',
      field('Twitch', textInput(c.twitch, (v) => { c.twitch = v.trim(); }, { placeholder: t('channel name, e.g. shroud') }), t('Read-only, no login needed. Subs, gifts, raids and cheers trigger on-stream alerts.')),
      field('YouTube', textInput(c.youtube, (v) => { c.youtube = v.trim(); }, { placeholder: t('@handle, channel ID or live video URL') }), t('Read-only, no API key needed. Super Chats and new members trigger alerts.')),
      note(t('TikTok does not offer a public live-chat API, so TikTok chat can only be opened as a pop-out.')),
    );
    const m = openModal({
      title: t('Connect chats'), width: 600, body,
      actions: [
        h('button.btn.btn-ghost', { onClick: () => m.close() }, t('Cancel')),
        h('button.btn.btn-primary', { onClick: () => {
          state.settings.chat = c;
          commit('settings');
          app.chat.connect();
          renderStatus();
          m.close();
          toast(t('Chat connections updated'), { type: 'ok' });
        } }, t('Connect')),
      ],
    });
  }

  app.chat.on('message', onMessage);
  app.chat.on('delete', onDelete);
  app.chat.on('status', renderStatus);
  app.chat.on('rate', ({ perMin, level }) => {
    if (!hypeFill) return;
    hypeFill.style.width = `${Math.min(100, level * 100)}%`;
    hypeWrap.classList.toggle('hot', level >= 1);
    rateEl.textContent = `${Math.round(perMin)}/min`;
  });
  render();
  return registerPanel({ render, settings });
}
