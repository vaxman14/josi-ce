'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// This isolated local page can only acknowledge the exact displayed review.
// The main process performs OS authentication and owns the consent socket.
contextBridge.exposeInMainWorld('josiProtected', {
  state: () => ipcRenderer.invoke('josi:device-consent-state'),
  decide: (challengeId, decision) => ipcRenderer.invoke('josi:device-consent-decide', { challengeId, decision }),
  onState: listener => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('josi:device-consent-state-changed', receive);
    return () => ipcRenderer.removeListener('josi:device-consent-state-changed', receive);
  },
});
