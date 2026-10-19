'use strict';
const { isIP } = require('node:net');

function privateHost(host) {
  if (host === 'localhost' || host === '[::1]') return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function assertAllowedJosiCeUrl(value, mode = 'public') {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter your Josi server address.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete Josi server address.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Use the server address without credentials, query parameters, or fragments.');
  if (mode === 'tailscale' && (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net'))) throw new Error('Use the private HTTPS .ts.net address from your Josi installation.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost(url.hostname))) throw new Error('Use HTTPS; local test installations can use private-network HTTP.');
  return url.origin;
}

function sameOrigin(value, origin) {
  try { const u = new URL(value); return !u.username && !u.password && u.origin === origin; } catch { return false; }
}

function internalRoute(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try { const u = new URL(value, origin); return sameOrigin(u.href, origin) ? u.href : null; } catch { return null; }
}

function requireTrustedFrame(event, window, expectedUrl, local = false) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) throw new Error('This window cannot use the native bridge.');
  const actual = event.senderFrame.url;
  if (local ? actual !== expectedUrl : !sameOrigin(actual, expectedUrl)) throw new Error('The native bridge is unavailable on this page.');
}

function reconnectDelay(attempt, random = Math.random) {
  const exponent = Number.isFinite(attempt) ? Math.max(0, attempt) : 0;
  const base = Math.min(800 * (1.8 ** exponent), 30_000);
  const sample = random();
  return Math.round(base * (0.8 + Math.max(0, Math.min(1, Number.isFinite(sample) ? sample : 0.5)) * 0.4));
}

module.exports = { assertAllowedJosiCeUrl, sameOrigin, internalRoute, requireTrustedFrame, reconnectDelay };
