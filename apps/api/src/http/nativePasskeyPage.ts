// The pages a native app opens in the system browser to use or add a passkey.
//
// All of it is fixed text. Nothing from the request is written into it: a script
// reads `state` and any ticket from its own address. That leaves no escaping to
// get wrong, and it means a script can load as a same-origin file under the app's
// `script-src 'self'`.
import { GOOGLE_NATIVE_RETURN_URI } from '@josi-ce/auth';

const page = (title: string, lead: string, action: string, script: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: #150B19; color: #F3E9F2; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 380px; padding: 32px 28px; background: #2C1A33; border: 1px solid rgba(240, 207, 122, .25); border-radius: 16px; }
h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
p { margin: 0 0 24px; }
button, a { display: block; width: 100%; min-height: 44px; padding: 10px 16px; border-radius: 10px; font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
#continue, #back { background: #F0CF7A; color: #150B19; border: 0; }
#continue:disabled { opacity: .6; cursor: default; }
#cancel { margin-top: 8px; background: transparent; color: #F3E9F2; border: 1px solid rgba(243, 233, 242, .3); }
button:focus-visible, a:focus-visible { outline: 2px solid #F0CF7A; outline-offset: 2px; }
[hidden] { display: none; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p id="status" role="status">${lead}</p>
<button id="continue" type="button" disabled>${action}</button>
<button id="cancel" type="button">Cancel</button>
<a id="back" hidden>Open Josi</a>
</main>
<script src="/api/auth/passkey/native/${script}" defer></script>
</body>
</html>
`;

export const NATIVE_PASSKEY_PAGE = page('Sign in to Josi', 'Use your passkey to finish signing in to the Josi app.', 'Continue with passkey', 'page.js');
export const NATIVE_PASSKEY_ADD_PAGE = page('Add a passkey', 'Add a passkey for Josi so this device can sign in with it.', 'Add passkey', 'add.js');

const script = (words: { failed: string; cancelled: string; waiting: string }, body: string) => `'use strict';
(() => {
  const RETURN_URI = ${JSON.stringify(GOOGLE_NATIVE_RETURN_URI)};
  const query = new URLSearchParams(location.search);
  const state = query.get('state') || '';
  const status = document.getElementById('status');
  const continueButton = document.getElementById('continue');
  const cancelButton = document.getElementById('cancel');
  const back = document.getElementById('back');

  const toBytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const fromBytes = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const callback = error => RETURN_URI + '?' + new URLSearchParams({ error, state }).toString();

  // The link stays on the page because a browser can hold or refuse the jump to
  // the app, and a person should not be left with nothing to press.
  function leave(url, message) {
    status.textContent = message;
    continueButton.hidden = true;
    cancelButton.hidden = true;
    back.href = url;
    back.hidden = false;
    location.href = url;
  }
  const failed = () => leave(callback('passkey_failed'), ${JSON.stringify(words.failed)});
  const cancelled = () => leave(callback('passkey_cancelled'), ${JSON.stringify(words.cancelled)});

  async function post(path, csrf, body) {
    const res = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-josi-csrf': csrf },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, body: await res.json().catch(() => null) };
  }

  // Fetched before the press, not after. Safari only allows the passkey prompt
  // right after a press, and a network wait in between can lose that.
  let ready = null;
  async function begin(path, body) {
    if (!window.PublicKeyCredential) throw new Error('This browser cannot use passkeys.');
    const { csrfToken } = await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json();
    const started = await post(path, csrfToken, body);
    if (!started.ok || !started.body || !started.body.options) throw new Error('The server did not start a passkey request.');
    ready = { csrf: csrfToken, options: started.body.options };
    continueButton.disabled = false;
  }

  const finish = (verified, message) => {
    const url = verified.body && verified.body.redirect;
    if (typeof url !== 'string' || !url.startsWith(RETURN_URI + '?')) return failed();
    return verified.ok ? leave(url, message) : leave(url, ${JSON.stringify(words.failed)});
  };

  async function press(work) {
    continueButton.disabled = true;
    status.textContent = ${JSON.stringify(words.waiting)};
    try { return await work(); }
    catch (err) { return err && (err.name === 'NotAllowedError' || err.name === 'AbortError') ? cancelled() : failed(); }
  }

${body}

  cancelButton.addEventListener('click', cancelled);
})();
`;

export const NATIVE_PASSKEY_SCRIPT = script({
  failed: 'That passkey did not work. Go back to Josi to try again.',
  cancelled: 'Sign-in was cancelled. You can go back to Josi.',
  waiting: 'Waiting for your passkey.',
}, `  continueButton.addEventListener('click', () => press(async () => {
    const { csrf, options } = ready;
    const credential = await navigator.credentials.get({ publicKey: { ...options, challenge: toBytes(options.challenge) } });
    if (!credential) return cancelled();
    const response = credential.response;
    return finish(await post('/api/auth/passkey/native/verify', csrf, {
      state,
      credentialId: fromBytes(credential.rawId),
      clientDataJSON: fromBytes(response.clientDataJSON),
      authenticatorData: fromBytes(response.authenticatorData),
      signature: fromBytes(response.signature),
      userHandle: response.userHandle ? fromBytes(response.userHandle) : null,
    }), 'You are signed in. Going back to Josi.');
  }));
  begin('/api/auth/passkey/options', {}).catch(failed);`);

export const NATIVE_PASSKEY_ADD_SCRIPT = script({
  failed: 'The passkey was not added. Go back to Josi to try again.',
  cancelled: 'No passkey was added. You can go back to Josi.',
  waiting: 'Waiting for your device.',
}, `  const ticket = query.get('ticket') || '';
  continueButton.addEventListener('click', () => press(async () => {
    const { csrf, options } = ready;
    const credential = await navigator.credentials.create({ publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(key => ({ ...key, id: toBytes(key.id) })),
    } });
    if (!credential) return cancelled();
    const response = credential.response;
    return finish(await post('/api/auth/passkey/native/add/finish', csrf, {
      ticket,
      state,
      clientDataJSON: fromBytes(response.clientDataJSON),
      attestationObject: fromBytes(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : [],
    }), 'Your passkey was added. Going back to Josi.');
  }));
  begin('/api/auth/passkey/native/add/options', { ticket, state }).catch(failed);`);
