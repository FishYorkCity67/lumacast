'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'app:quit', 'state:load', 'state:save', 'ffmpeg:set', 'capture:sources',
  'engine:start', 'engine:stop', 'engine:replay', 'outputs:start', 'outputs:stop',
  'record:start', 'record:stop', 'replay:save', 'markers:save',
  'dialog:file', 'dialog:folder', 'file:read', 'shell:open', 'shell:reveal', 'shell:external',
  'hotkeys:set', 'chat:connect', 'chat:popout', 'winwatch:set', 'power:block',
  'browser:set', 'browser:remove', 'browser:keep', 'log', 'test:capture', 'test:exit',
]);
const SEND = new Set(['engine:video', 'engine:audio', 'browser:ack']);
const ON = new Set([
  'stats', 'outputs:status', 'outputs:congestion', 'record:status', 'engine:fault', 'hotkey',
  'chat:message', 'chat:event', 'chat:delete', 'chat:status', 'winwatch:focus', 'browser:frame',
  'app:confirm-close',
]);

contextBridge.exposeInMainWorld('lc', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error(`blocked ${ch}`))),
  send: (ch, ...args) => { if (SEND.has(ch)) ipcRenderer.send(ch, ...args); },
  on: (ch, fn) => {
    if (!ON.has(ch)) return () => {};
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
});
