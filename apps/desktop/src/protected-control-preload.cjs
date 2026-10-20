'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('josiProtected', {
  state: () => ipcRenderer.invoke('josi:protected-state'),
  decide: (challengeId, decision) => ipcRenderer.invoke('josi:protected-decide', { challengeId, decision }),
  onState: listener => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('josi:protected-state-changed', receive);
    return () => ipcRenderer.removeListener('josi:protected-state-changed', receive);
  },
});
