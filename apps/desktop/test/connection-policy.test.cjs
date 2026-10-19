'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAllowedJosiCeUrl, internalRoute, requireTrustedFrame, reconnectDelay } = require('../src/connection-policy.cjs');

test('CE connections accept secure servers and exact private development hosts', () => {
  for (const url of ['https://josi.example.com', 'https://device.tailnet.ts.net', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://10.1.2.3', 'http://192.168.1.4', 'http://172.16.0.1']) assert.equal(assertAllowedJosiCeUrl(url), new URL(url).origin);
  for (const url of ['http://localhost.evil.test', 'http://127.0.0.1.evil.test', 'http://10.evil.test', 'http://172.32.0.1', 'http://public.example', 'file:///tmp/josi', 'javascript:alert(1)', 'https://user:password@josi.example', 'https://josi.example?token=fixture', 'https://josi.example#fixture']) assert.throws(() => assertAllowedJosiCeUrl(url));
  assert.throws(() => assertAllowedJosiCeUrl('https://ts.net.evil.test', 'tailscale'));
});
test('notification routes cannot navigate a trusted window to another origin or scheme', () => {
  const origin = 'https://josi.example';
  assert.equal(internalRoute('/talk?thread=fixture', origin), `${origin}/talk?thread=fixture`);
  for (const route of ['//evil.test', '/\\evil.test', 'https://evil.test', 'javascript:1', undefined]) assert.equal(internalRoute(route, origin), null);
});
test('native IPC requires the selected window, current origin, and top frame', () => {
  const mainFrame = { url: 'https://josi.example/talk' };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.doesNotThrow(() => requireTrustedFrame(event, window, 'https://josi.example'));
  assert.throws(() => requireTrustedFrame({ ...event, senderFrame: { ...mainFrame } }, window, 'https://josi.example'));
  assert.throws(() => requireTrustedFrame({ ...event, sender: {} }, window, 'https://josi.example'));
  mainFrame.url = 'https://evil.test';
  assert.throws(() => requireTrustedFrame(event, window, 'https://josi.example'));
  mainFrame.url = 'file:///app/shell.html';
  assert.doesNotThrow(() => requireTrustedFrame(event, window, mainFrame.url, true));
  assert.throws(() => requireTrustedFrame(event, window, 'file:///app/other.html', true));
});
test('reconnect delays remain bounded', () => {
  assert.equal(reconnectDelay(0, () => 0.5), 800);
  assert.equal(reconnectDelay(1000, () => 1), 36000);
  assert.equal(reconnectDelay(NaN, () => NaN), 800);
});
