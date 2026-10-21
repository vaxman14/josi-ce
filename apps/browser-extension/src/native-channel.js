'use strict';
// A live native port binds Chromium/Firefox to one host process and keeps the
// MV3 worker alive. Safari uses its containing app's native request handler.
// A lost connection never reconnects or replays an outstanding operation.
globalThis.createJosiNativeChannel = function createJosiNativeChannel(api, family, disconnected) {
  const host = family === 'safari' ? 'com.heyjosi.ce.unified' : 'com.heyjosi.browser';
  const pending = new Map();
  let port = null, closed = false, closing = false;
  const bounded = value => {
    try { return new TextEncoder().encode(JSON.stringify(value)).length <= 192 * 1024; }
    catch { return false; }
  };
  function close(notify = false) {
    if (closed || closing) return;
    closing = true; closed = true;
    for (const flight of pending.values()) { clearTimeout(flight.timer); flight.reject(new Error('host_disconnected')); }
    pending.clear();
    const previous = port; port = null;
    if (previous) { try { previous.disconnect(); } catch { /* Already closed. */ } }
    closing = false;
    if (notify) disconnected();
  }
  function receive(response) {
    if (closed) return;
    const flight = response && bounded(response) && response.version === 1 ? pending.get(response.requestId) : null;
    if (!flight) { close(true); return; }
    pending.delete(response.requestId); clearTimeout(flight.timer);
    flight.resolve(response);
  }
  if (family !== 'safari') {
    try {
      port = api.runtime.connectNative(host);
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(() => {
        // Read the browser error to acknowledge it, never log its body.
        void api.runtime.lastError;
        close(true);
      });
    } catch { close(); }
  }
  return Object.freeze({
    close: () => close(),
    request(request) {
      if (closed || !bounded(request) || typeof request?.requestId !== 'string'
        || pending.has(request.requestId) || pending.size >= 2
        || pending.size && request.operation !== 'browser.stop') return Promise.reject(new Error('host_unavailable'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(true), 5000);
        pending.set(request.requestId, { resolve, reject, timer });
        try {
          if (family === 'safari') {
            Promise.resolve(api.runtime.sendNativeMessage(host, request)).then(receive, () => close(true));
          } else {
            if (!port) throw new Error('host_unavailable');
            port.postMessage(request);
          }
        } catch { close(true); }
      });
    },
  });
};
