'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('josiDesktop', {
  platform: process.platform,
  capabilities: () => ipcRenderer.invoke('josi:capabilities'),
  protectedChanges: {
    available: () => ipcRenderer.invoke('josi:protected-available'),
    review: (challengeId) => ipcRenderer.invoke('josi:protected-review', { challengeId }),
  },
  notify: (title, body, route) => ipcRenderer.invoke('josi:desktop-notify', { title, body, route }),
  confirmApproval: (summary) => ipcRenderer.invoke('josi:confirm-approval', { summary }),
  localWorkspace: {
    state: () => ipcRenderer.invoke('josi:workspace-state'),
    selectFolder: (writable) => ipcRenderer.invoke('josi:workspace-select-folder', { writable: writable === true }),
    revoke: (rootId) => ipcRenderer.invoke('josi:workspace-revoke', { rootId }),
    execute: (request) => ipcRenderer.invoke('josi:workspace-execute', request),
  },
  onRemember: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('josi:remember', handler);
    return () => ipcRenderer.removeListener('josi:remember', handler);
  },
});
