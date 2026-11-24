'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell, globalShortcut, powerSaveBlocker, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Store } = require('./store');
const { findFfmpeg, ffmpegVersion } = require('./ffmpeg');
const { Engine, Output, remuxToMp4, writeClip } = require('./engine');
const { RtmpOutput } = require('./rtmp');
const { TwitchChat } = require('./chat/twitch');
const { YouTubeChat } = require('./chat/youtube');
const { WindowWatcher } = require('./winwatch');
const { BrowserSources } = require('./browser-sources');

const DEV = !!process.env.LUMACAST_DEV;
if (process.env.LUMACAST_USERDATA) app.setPath('userData', process.env.LUMACAST_USERDATA);

// Settings that must be known before the GPU process starts live in prefs.json.
const prefsFile = path.join(app.getPath('userData'), 'prefs.json');
let prefs = {};
try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { /* first run */ }
if (prefs.highPerformanceGpu !== false) app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Screen capture via DXGI desktop duplication instead of Windows Graphics
// Capture: WGC screen capture can hide the hardware cursor inside fullscreen
// games. Window capture keeps WGC (needed for GPU-rendered game windows).
if (prefs.wgcScreenCapture !== true) app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.setAppUserModelId('app.lumacast.studio');

if (!DEV && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let allowClose = false;
let powerBlocker = null;
const store = new Store(app.getPath('userData'));
const engine = new Engine(log);
const outputs = new Map();
const recorders = new Map();
const twitch = new TwitchChat();
const youtube = new YouTubeChat();
const ownNames = ['electron', path.basename(process.execPath, '.exe')];
const watcher = new WindowWatcher(ownNames);
const browserSources = new BrowserSources(() => (win && !win.isDestroyed() ? win.webContents : null));
let ffmpegPath = findFfmpeg(prefs.ffmpegPath);

const logDir = path.join(app.getPath('userData'), 'logs');
const logFile = path.join(logDir, 'lumacast.log');
function log(tag, msg) {
  const line = `${new Date().toISOString()} [${tag}] ${msg}\n`;
  if (DEV) process.stdout.write(line);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, line);
  } catch { /* logging must never break streaming */ }
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

const defaultMediaDir = () => path.join(app.getPath('videos'), 'Lumacast');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 60);

function buildUrl(dest) {
  const server = String(dest.server || '').trim().replace(/\/+$/, '');
  const key = String(dest.key || '').trim();
  return key ? `${server}/${key}` : server;
}

// Top-level app windows with their process (includes minimized ones, which
// desktopCapturer leaves out - e.g. fullscreen games after Alt+Tab).
let procWinCache = { at: 0, list: [] };
function processWindows() {
  if (Date.now() - procWinCache.at < 2500) return Promise.resolve(procWinCache.list);
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { ('{0}' + [char]9 + '{1}' + [char]9 + '{2}') -f $_.MainWindowHandle, $_.ProcessName, $_.MainWindowTitle }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => {
      const list = err ? [] : String(out).split(/\r?\n/).filter(Boolean).map((l) => {
        const [hwnd, process, ...title] = l.split('\t');
        return { hwnd: hwnd.trim(), process, title: title.join('\t') };
      });
      procWinCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1640, area.width),
    height: Math.min(980, area.height),
    minWidth: 1180,
    minHeight: 700,
    show: false,
    title: 'Lumacast',
    backgroundColor: '#08090f',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0c14', symbolColor: '#c9cdea', height: 46 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    if (area.width <= 1920 && !DEV) win.maximize();
    win.show();
  });
  win.on('close', (e) => {
    if (allowClose) return;
    const busy = engine.running || recorders.size || outputs.size;
    if (busy) {
      e.preventDefault();
      send('app:confirm-close');
    }
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.env.LUMACAST_TEST_SCRIPT) {
    win.webContents.once('did-finish-load', () => {
      const code = fs.readFileSync(process.env.LUMACAST_TEST_SCRIPT, 'utf8');
      setTimeout(() => win.webContents.executeJavaScript(code).catch((err) => log('test', String(err))), 1500);
    });
  }
}

function setupPermissions() {
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(!!win && wc === win.webContents && allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.has(perm));
}

// ---- CPU / disk stats ------------------------------------------------------
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] || c;
    const t = (k) => c.times[k] - p.times[k];
    const sum = t('user') + t('nice') + t('sys') + t('idle') + t('irq');
    total += sum;
    idle += t('idle');
  });
  lastCpu = now;
  return total ? Math.round((1 - idle / total) * 100) : 0;
}

function diskFreeGB(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return Math.round((s.bavail * s.bsize) / 1e9);
  } catch {
    return null;
  }
}

let recordDir = defaultMediaDir();
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const list = [...outputs.values(), ...[...recorders.values()].map((r) => r.out)].map((o) => o.stats());
  const procs = {};
  for (const m of app.getAppMetrics()) procs[m.type] = Math.round((procs[m.type] || 0) + m.cpu.percentCPUUsage);
  send('stats', { outputs: list, cpu: cpuPercent(), procs, diskGB: diskFreeGB(recordDir), engine: engine.running });
}, 1000);

// ---- IPC -------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    ffmpeg: ffmpegPath,
    ffmpegVersion: ffmpegPath ? ffmpegVersion(ffmpegPath) : null,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    locale: app.getLocale(),
    videosDir: defaultMediaDir(),
    userData: app.getPath('userData'),
    logFile,
    dev: DEV,
    cpus: os.cpus().length,
  }));

  ipcMain.handle('app:quit', () => {
    allowClose = true;
    for (const o of outputs.values()) o.stop();
    engine.stop();
    if (win) win.close();
  });

  ipcMain.handle('state:load', () => store.load());
  ipcMain.handle('state:save', (_e, state) => {
    store.save(state);
    const s = state.settings || {};
    const next = { highPerformanceGpu: s.highPerformanceGpu !== false, ffmpegPath: s.ffmpegPath || '' };
    if (JSON.stringify(next) !== JSON.stringify(prefs)) {
      prefs = next;
      try { fs.writeFileSync(prefsFile, JSON.stringify(prefs)); } catch { /* non-fatal */ }
    }
    if (s.recording && s.recording.folder) recordDir = s.recording.folder;
    return true;
  });

  ipcMain.handle('ffmpeg:set', (_e, p) => {
    const found = findFfmpeg(p);
    if (found) ffmpegPath = found;
    return { ffmpeg: ffmpegPath, version: ffmpegPath ? ffmpegVersion(ffmpegPath) : null };
  });

  ipcMain.handle('capture:sources', async (_e, types, thumbs = true) => {
    const sources = await desktopCapturer.getSources({
      types: types || ['screen', 'window'],
      thumbnailSize: thumbs ? { width: 400, height: 225 } : { width: 0, height: 0 },
      fetchWindowIcons: !!thumbs,
    });
    const own = win ? win.getMediaSourceId() : '';
    const list = sources
      .filter((s) => s.id !== own)
      .map((s) => ({
        id: s.id,
        name: s.name,
        displayId: s.display_id,
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      }));
    if (!(types || []).includes('window')) return list;
    const procs = await processWindows();
    const ownNamesLc = ownNames.map((n) => n.toLowerCase());
    for (const s of list) {
      const hwnd = (/^window:(\d+):/.exec(s.id) || [])[1];
      const p = hwnd && procs.find((x) => x.hwnd === hwnd);
      if (p) s.process = p.process;
    }
    for (const p of procs) {
      if (ownNamesLc.includes(p.process.toLowerCase())) continue;
      if (list.some((s) => s.id.startsWith(`window:${p.hwnd}:`))) continue;
      // not capturable right now (usually minimized): offer it anyway
      list.push({ id: `pending:${p.process}`, name: p.title, process: p.process, minimized: true, thumbnail: '', icon: '' });
    }
    return list;
  });

  // engine
  ipcMain.handle('engine:start', (_e, cfg) => {
    if (!ffmpegPath) throw new Error('FFmpeg not found');
    engine.start(ffmpegPath, cfg);
    log('engine', `start ${JSON.stringify(cfg.canvases.map((c) => `${c.key}:${c.width}x${c.height}@${c.fps} ${c.kbps}k`))}`);
    return true;
  });
  ipcMain.handle('engine:stop', async () => {
    const list = [...outputs.values()];
    list.forEach((o) => o.stop());
    await Promise.all(list.map((o) => o.closed()));
    outputs.clear();
    engine.stop();
    log('engine', 'stop');
    return true;
  });
  ipcMain.on('engine:video', (_e, key, data, ts, isKey, desc) => engine.video(key, data, ts, isKey, desc));
  ipcMain.on('engine:audio', (_e, pcm) => engine.audio(pcm));
  ipcMain.handle('engine:replay', (_e, seconds) => engine.setReplay(seconds));
  engine.on('fault', (msg) => {
    log('engine', msg);
    send('engine:fault', msg);
  });

  // destinations
  ipcMain.handle('outputs:start', (_e, dests) => {
    for (const d of dests) {
      const prev = outputs.get(d.id);
      if (prev) prev.stop();
      const out = d.engine === 'ffmpeg'
        ? new Output({ id: d.id, name: d.name, kind: 'rtmp', canvas: d.canvas, url: buildUrl(d), secret: d.key }, engine, ffmpegPath, log)
        : new RtmpOutput({ id: d.id, name: d.name, canvas: d.canvas, server: d.server, key: d.key }, engine, log);
      out.on('status', (status, error) => {
        log(d.name, `status ${status}${error ? ` (${error})` : ''}`);
        send('outputs:status', { id: d.id, status, error });
      });
      out.on('congestion', () => send('outputs:congestion', { id: d.id, canvas: d.canvas }));
      outputs.set(d.id, out);
      out.start();
    }
    return true;
  });
  ipcMain.handle('outputs:stop', async (_e, ids) => {
    const list = (ids || [...outputs.keys()]).map((id) => outputs.get(id)).filter(Boolean);
    list.forEach((o) => o.stop());
    await Promise.all(list.map((o) => o.closed()));
    list.forEach((o) => outputs.delete(o.id));
    return true;
  });

  // recording
  ipcMain.handle('record:start', (_e, { canvases, folder, remux }) => {
    const dir = folder || defaultMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    recordDir = dir;
    const base = `Lumacast ${stamp()}`;
    for (const c of canvases) {
      const file = path.join(dir, `${base}${c === 'v' ? ' (vertical)' : ''}`);
      const out = new Output({ id: `rec-${c}`, name: c === 'v' ? 'Recording 9:16' : 'Recording', kind: 'record', canvas: c, file: `${file}.mkv` }, engine, ffmpegPath, log);
      out.on('status', (status, error) => send('record:status', { canvas: c, status, error }));
      recorders.set(c, { out, file, remux: remux !== false });
      out.start();
    }
    return true;
  });
  ipcMain.handle('record:stop', async () => {
    const files = [];
    const list = [...recorders.values()];
    recorders.clear();
    list.forEach((r) => r.out.stop());
    for (const r of list) {
      await r.out.closed();
      for (const mkv of r.out.files) {
        if (!fs.existsSync(mkv)) continue;
        files.push(r.remux ? await remuxToMp4(ffmpegPath, mkv, mkv.replace(/\.mkv$/i, '.mp4')) : mkv);
      }
    }
    return files;
  });

  // instant replay
  ipcMain.handle('replay:save', async (_e, { canvases, folder, seconds, label }) => {
    const dir = path.join(folder || defaultMediaDir(), 'Clips');
    fs.mkdirSync(dir, { recursive: true });
    const base = `Clip ${stamp()}${label ? ` ${safeName(label)}` : ''}`;
    const files = [];
    for (const c of canvases) {
      const m = engine.muxers.get(c);
      const snap = m && m.snapshot(seconds * 1000);
      if (!snap) continue;
      const file = path.join(dir, `${base}${c === 'v' ? ' (vertical)' : ''}.mp4`);
      const r = await writeClip(ffmpegPath, snap.flv, file);
      if (r.ok) files.push(file);
      else log('clip', r.error);
    }
    return files;
  });

  ipcMain.handle('markers:save', (_e, { folder, text }) => {
    const dir = folder || defaultMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Markers ${stamp()}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  });

  // files & shell
  ipcMain.handle('dialog:file', async (_e, { filters, title }) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:folder', async (_e, { title, defaultPath }) => {
    const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('file:read', (_e, p) => {
    const ext = path.extname(String(p)).toLowerCase();
    if (!['.gif', '.webp', '.png', '.apng', '.jpg', '.jpeg', '.avif', '.bmp'].includes(ext)) throw new Error('Unsupported file type');
    if (fs.statSync(p).size > 80 * 1024 * 1024) throw new Error('File too large');
    return fs.readFileSync(p);
  });
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:external', (_e, url) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  });

  // hotkeys
  ipcMain.handle('hotkeys:set', (_e, map) => {
    globalShortcut.unregisterAll();
    const failed = [];
    for (const [action, acc] of Object.entries(map || {})) {
      if (!acc) continue;
      try {
        if (!globalShortcut.register(acc, () => send('hotkey', action))) failed.push(action);
      } catch {
        failed.push(action);
      }
    }
    return failed;
  });

  // chat
  ipcMain.handle('chat:connect', (_e, { twitch: tw, youtube: yt }) => {
    if (tw) twitch.start(tw); else twitch.stop();
    if (yt) youtube.start(yt); else youtube.stop();
    return true;
  });
  for (const [name, client] of [['twitch', twitch], ['youtube', youtube]]) {
    client.on('message', (m) => send('chat:message', m));
    client.on('event', (ev) => send('chat:event', ev));
    client.on('delete', (d) => send('chat:delete', d));
    client.on('status', (s) => send('chat:status', s));
    client.on('error', (err) => log(name, String(err)));
  }
  ipcMain.handle('chat:popout', (_e, url) => {
    if (!/^https:\/\/(www\.)?(twitch\.tv|youtube\.com|studio\.youtube\.com|tiktok\.com|livecenter\.tiktok\.com)\//i.test(url)) return false;
    const pop = new BrowserWindow({
      width: 420, height: 760, title: 'Chat', backgroundColor: '#0b0c14', autoHideMenuBar: true,
      webPreferences: { partition: 'persist:lumacast-chat', contextIsolation: true, sandbox: true },
    });
    pop.loadURL(url);
    return true;
  });

  // privacy shield / automation
  ipcMain.handle('winwatch:set', (_e, on) => {
    if (on) watcher.start(); else watcher.stop();
    return watcher.current;
  });
  watcher.on('focus', (info) => send('winwatch:focus', info));

  ipcMain.handle('power:block', (_e, on) => {
    if (on && powerBlocker === null) powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && powerBlocker !== null) {
      powerSaveBlocker.stop(powerBlocker);
      powerBlocker = null;
    }
  });

  // browser sources
  ipcMain.handle('browser:set', (_e, id, cfg) => browserSources.set(id, cfg));
  ipcMain.handle('browser:remove', (_e, id) => browserSources.remove(id));
  ipcMain.handle('browser:keep', (_e, ids) => browserSources.keepOnly(ids));
  ipcMain.on('browser:ack', (_e, id) => browserSources.ack(id));

  ipcMain.handle('log', (_e, tag, msg) => log(tag, msg));

  if (DEV) {
    ipcMain.handle('test:capture', async (_e, file) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
      return file;
    });
    ipcMain.handle('test:exit', () => {
      allowClose = true;
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  setupPermissions();
  registerIpc();
  createWindow();
  log('app', `start v${app.getVersion()} electron ${process.versions.electron} ffmpeg ${ffmpegPath || 'missing'}`);
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher.stop();
  twitch.stop();
  youtube.stop();
  browserSources.destroyAll();
  for (const o of outputs.values()) o.stop();
  engine.stop();
});

app.on('window-all-closed', () => app.quit());
