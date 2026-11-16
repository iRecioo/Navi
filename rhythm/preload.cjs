const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('naviRhythm', {
  load: () => ipcRenderer.invoke('navi-rhythm:load'),
  chart: (notes, duration) => ipcRenderer.invoke('navi-rhythm:chart', { notes, duration }),
  finish: stats => ipcRenderer.invoke('navi-rhythm:finish', stats),
  startSpotify: () => ipcRenderer.invoke('navi-rhythm:spotify-start'),
  openSpotify: () => ipcRenderer.invoke('navi-rhythm:spotify-open'),
  onSpotify: callback => ipcRenderer.on('navi-rhythm:spotify-event', (_event, data) => callback(data)),
  cancel: () => ipcRenderer.invoke('navi-rhythm:cancel'),
  fail: message => ipcRenderer.invoke('navi-rhythm:fail', message),
  onHit: callback => ipcRenderer.on('navi-rhythm:hit', (_event, lane, queuedMs) => callback(lane, queuedMs))
});
