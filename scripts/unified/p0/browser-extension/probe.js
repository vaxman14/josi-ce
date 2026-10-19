'use strict';
const api = globalThis.browser ?? globalThis.chrome;
document.getElementById('run').addEventListener('click', async () => {
  const result = document.getElementById('result');
  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    const url = new URL(tab.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/josi-p0-fixture') {
      throw new Error('Open the synthetic local Josi P0 fixture in this test workspace.');
    }
    const [observation] = await api.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => {
        const marker = document.querySelector('meta[name="josi-p0-fixture"]');
        if (marker?.content !== 'synthetic-only') throw new Error('Fixture marker missing');
        return {title: document.title, buttons: document.querySelectorAll('button').length};
      },
    });
    const nonce = crypto.randomUUID();
    const native = await api.runtime.sendNativeMessage('com.socalreceptionist.josi.p0', {version: 1, method: 'probe', nonce});
    if (native?.version !== 1 || native?.nonce !== nonce || native?.method !== 'probe') throw new Error('Native response did not match');
    result.textContent = JSON.stringify({passed: true, observation: observation.result, native}, null, 2);
  } catch (error) {
    result.textContent = JSON.stringify({passed: false, message: error.message}, null, 2);
  }
});
