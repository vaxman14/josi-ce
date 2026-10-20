'use strict';
// Explicit test entry point, never imported by the application. Fixture signing
// keys and OS-presence responses are synthetic and exist only in memory.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createProtectedConfirmationSurface } = require('../src/protected-control.cjs');
const { createProtectedConfirmationBroker, verifyProtectedControlSignature } = require('../../../packages/automation/dist/index.js');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'josi-protected-ui-fixture-')));
app.whenReady().then(async () => {
  const parent = new BrowserWindow({ width: 640, height: 500, webPreferences: {
    // Deliberately expose the small review bridge in the WRONG fixture window
    // to verify that main-process sender checks still reject every request.
    preload: path.resolve(__dirname, '../src/protected-control-preload.cjs'),
    contextIsolation: true, sandbox: true, nodeIntegration: false, partition: `fixture-${randomUUID()}` } });
  let supported = true, authCalls = 0, authFinish = null, signatures = 0;
  const surface = createProtectedConfirmationSurface({ BrowserWindow, ipcMain, session, parentWindow: () => parent,
    systemPreferences: { canPromptTouchID: () => supported, promptTouchID: async () => { authCalls++; await new Promise(resolve => { authFinish = resolve; }); } } });
  const keys = generateKeyPairSync('ed25519');
  const identity = { serverOrigin: 'https://josi.example', serverId: randomUUID(), userId: randomUUID(), deviceId: randomUUID() };
  let challenge, result = null, checks = 0, holdAfterAuthentication = false, checkFinish = null;
  const broker = createProtectedConfirmationBroker(identity, {
    loadChallenge: async () => challenge, present: surface.present, authenticate: surface.authenticate,
    isCurrent: async () => {
      checks++;
      if (checks === 3 && holdAfterAuthentication) await new Promise(resolve => { checkFinish = resolve; });
      return true;
    }, sign: async (_challenge, message) => { signatures++; return sign(null, message, keys.privateKey).toString('base64url'); },
  });
  globalThis.protectedFixture = {
    start(options = {}) {
      supported = options.supported !== false; result = null; checks = 0;
      holdAfterAuthentication = options.holdAfterAuthentication === true;
      const now = Date.now();
      challenge = { schemaVersion: 1, id: randomUUID(), nonce: 'a'.repeat(43), ...identity,
        purpose: 'cardinal.activate', requestDigest: 'b'.repeat(64),
        keyReference: { recordId: randomUUID(), version: 1, digest: 'c'.repeat(64), epoch: 1 },
        issuedAtMs: now, expiresAtMs: now + 120000, presentation: {
          wording: 'Never delete files in the bookkeeping workspace.\n<script>window.injected = true</script>',
          meaning: 'Deny every file.delete action in the bookkeeping workspace, for every task and every user.\nIf the workspace cannot be identified, pause the action.',
          advisory: ['The restriction is explicit. It covers deletion, including actions performed through another tool.',
            'Moving or editing a file is a different action. Add a separate restriction if those actions must also be blocked.'],
        } };
      void broker.confirm(challenge.id).then(value => { result = value; }); return challenge.id;
    },
    finishAuthentication() { authFinish?.(); authFinish = null; },
    finishCheck() { checkFinish?.(); checkFinish = null; },
    cancel() { broker.cancel(); surface.cancel(); },
    inspect() { return { result, authCalls, signatures,
      verified: result?.status === 'confirmed' && verifyProtectedControlSignature(challenge, result.receipt, keys.publicKey) }; },
  };
  app.on('before-quit', () => { broker.cancel(); surface.dispose(); });
  await parent.loadFile(path.join(__dirname, 'protected-smoke-parent.html'));
});
app.on('window-all-closed', () => app.quit());
