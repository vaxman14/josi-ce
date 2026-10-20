'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('josiShell', {
  connect: (serverUrl) => ipcRenderer.invoke('josi:shell-connect', { serverUrl }),
  state: () => ipcRenderer.invoke('josi:shell-state'),
  openLocal: (page = 'home') => ipcRenderer.invoke('josi:shell-local', { page }),
  operate: (operation) => ipcRenderer.invoke('josi:shell-operation', { operation }),
  copyDiagnostics: () => ipcRenderer.invoke('josi:shell-diagnostics'),
});
