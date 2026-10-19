'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('josiShell', {
  connect: (serverUrl) => ipcRenderer.invoke('josi:shell-connect', { serverUrl }),
  state: () => ipcRenderer.invoke('josi:shell-state'),
});
