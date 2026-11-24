'use strict';
// Browser sources: web widgets (alert boxes, goal bars, ...) rendered in
// offscreen windows and streamed to the compositor as BGRA frames. Frames are
// flow-controlled: the next one is only sent after the renderer acks the last.
const { BrowserWindow, session } = require('electron');

const DEFAULT_CSS = 'html,body{background:transparent!important;overflow:hidden!important;margin:0}';

class BrowserSources {
  constructor(getTarget) {
    this.getTarget = getTarget;
    this.items = new Map();
    this._session = null;
  }

  // Created lazily: sessions only exist once the app is ready.
  get session() {
    if (!this._session) {
      this._session = session.fromPartition('persist:lumacast-browser-sources');
      this._session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    }
    return this._session;
  }

  set(id, cfg) {
    const width = Math.max(16, Math.min(3840, Math.round(cfg.width || 1280)));
    const height = Math.max(16, Math.min(2160, Math.round(cfg.height || 720)));
    const fps = Math.max(1, Math.min(60, Math.round(cfg.fps || 30)));
    const css = `${DEFAULT_CSS}\n${cfg.css || ''}`;
    let item = this.items.get(id);
    if (item && !item.win.isDestroyed()) {
      if (item.width !== width || item.height !== height) item.win.setContentSize(width, height);
      item.win.webContents.setFrameRate(fps);
      item.win.webContents.setAudioMuted(!!cfg.muted);
      const urlChanged = item.url !== cfg.url;
      Object.assign(item, { width, height, fps, css, url: cfg.url });
      if (urlChanged || cfg.reload) this._load(item);
      else this._applyCss(item);
      return;
    }
    const win = new BrowserWindow({
      show: false, width, height, useContentSize: true, frame: false, transparent: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, session: this.session },
    });
    win.setBackgroundColor('#00000000');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setFrameRate(fps);
    win.webContents.setAudioMuted(!!cfg.muted);
    item = { id, win, width, height, fps, css, url: cfg.url, inflight: false, pending: null, cssKey: null };
    this.items.set(id, item);
    win.webContents.on('paint', (_e, _dirty, image) => this._frame(item, image));
    win.webContents.on('did-finish-load', () => this._applyCss(item));
    this._load(item);
  }

  _load(item) {
    const url = String(item.url || '').trim();
    if (!/^(https?|file):/i.test(url)) {
      item.win.loadURL('about:blank');
      return;
    }
    item.win.loadURL(url).catch(() => {});
  }

  async _applyCss(item) {
    try {
      if (item.cssKey) await item.win.webContents.removeInsertedCSS(item.cssKey);
      item.cssKey = await item.win.webContents.insertCSS(item.css);
    } catch { /* page navigating */ }
  }

  _frame(item, image) {
    const target = this.getTarget();
    if (!target || target.isDestroyed()) return;
    if (item.inflight) {
      item.pending = image;
      return;
    }
    this._send(item, image, target);
  }

  _send(item, image, target) {
    const size = image.getSize();
    if (!size.width || !size.height) return;
    item.inflight = true;
    target.send('browser:frame', item.id, size.width, size.height, image.toBitmap());
  }

  ack(id) {
    const item = this.items.get(id);
    if (!item) return;
    item.inflight = false;
    if (item.pending) {
      const img = item.pending;
      item.pending = null;
      const target = this.getTarget();
      if (target && !target.isDestroyed()) this._send(item, img, target);
    }
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    if (!item.win.isDestroyed()) item.win.destroy();
  }

  keepOnly(ids) {
    const keep = new Set(ids);
    for (const id of [...this.items.keys()]) if (!keep.has(id)) this.remove(id);
  }

  destroyAll() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }
}

module.exports = { BrowserSources };
