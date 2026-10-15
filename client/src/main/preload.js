const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getHistory: () => ipcRenderer.invoke('history:get'),
  saveHistory: (messages) => ipcRenderer.invoke('history:set', messages),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  saveMemory: (memory) => ipcRenderer.invoke('memory:set', memory),
  tts: (text, voice) => ipcRenderer.invoke('tts', text, voice),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  getModelUrl: () => ipcRenderer.invoke('model:url'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('mouse:ignore', ignore),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  getAppState: () => ipcRenderer.invoke('app:state'),
  command: (name, arg) => ipcRenderer.send('app:command', name, arg),
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
});
