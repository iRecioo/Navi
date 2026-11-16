const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('naviArcade', {
  load: () => ipcRenderer.invoke('navi-arcade:load'),
  prepareVoice: () => ipcRenderer.invoke('navi-arcade:voice'),
  cancel: () => ipcRenderer.invoke('navi-arcade:cancel'),
  finish: result => ipcRenderer.invoke('navi-arcade:finish', result)
});
