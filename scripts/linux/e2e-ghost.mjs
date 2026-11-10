#!/usr/bin/env node
// Checks the Ghost Stage on an installed Josi, in a real browser: signs in with
// the saved test account, then proves the ghost actually animates.
//
//   sudo node scripts/linux/e2e-ghost.mjs <screenshot dir>
//
// It fails when any of the 14 clips or the still is missing or not served as
// media, when a /ghost/ request 404s, when the playing video does not advance,
// when Plum & Gold is not the default skin, or when the menu is not Workspace
// then Admin with no Home or Talk. Runs on the Josi machine, on loopback, like
// e2e-screens.mjs; the credentials come from /root/josi-e2e-credentials.json.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const BASE = process.env.E2E_BASE
  ?? `http://127.0.0.1:${JSON.parse(readFileSync('/var/lib/josi/data/config/runtime.json', 'utf8')).publicPort}`;
const out = process.argv[2] ?? '/tmp/josi-ghost';
const require = createRequire(resolve(process.env.PLAYWRIGHT_PATH ?? join(import.meta.dirname, '../../node_modules')) + '/');
const { chromium } = require('playwright');
const creds = JSON.parse(readFileSync('/root/josi-e2e-credentials.json', 'utf8'));
mkdirSync(out, { recursive: true });

export const CLIPS = ['idle-wiggle', 'listening', 'thinking', 'gentle-float', 'nod-along', 'ear-cup', 'chin-tap', 'explaining',
  'wave-hello', 'got-it', 'lightbulb', 'counting-off', 'celebrate', 'oops'];

function totp(secretBase32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

const results = {};
const step = async (name, work) => {
  try { results[name] = { ok: true, detail: (await work()) ?? '' }; }
  catch (error) { results[name] = { ok: false, detail: String(error?.message ?? error).slice(0, 600) }; }
  console.log(`${results[name].ok ? 'PASS' : 'FAIL'} ${name}${results[name].detail ? ' - ' + results[name].detail : ''}`);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
const page = await context.newPage();
const ghostResponses = [];
page.on('response', (res) => { if (new URL(res.url()).pathname.startsWith('/ghost/')) ghostResponses.push({ path: new URL(res.url()).pathname, status: res.status() }); });
try {
  await step('sign in', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#identifier', creds.username);
    await page.fill('#password', creds.password);
    await page.click('button[type=submit]:has-text("Sign in")');
    await page.getByText('One more step').waitFor({ timeout: 15_000 });
    if (Date.now() / 1000 % 30 > 25) await page.waitForTimeout(6_000);
    await page.locator('form input').first().click();
    await page.keyboard.type(totp(creds.totpSecret), { delay: 40 });
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  });

  await step('Plum & Gold is the default skin', async () => {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (theme !== 'plum-gold') throw new Error(`data-theme is ${theme}`);
    return theme;
  });

  await step('Ghost Stage is the chat and the ghost animates', async () => {
    await page.locator('.ghost-stage').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    const sample = () => page.evaluate(() => [...document.querySelectorAll('.ghost-figure video')]
      .map((v) => ({ src: v.currentSrc, paused: v.paused, t: v.currentTime, ready: v.readyState, w: v.videoWidth })));
    const a = await sample();
    await page.waitForTimeout(1_200);
    const b = await sample();
    await page.screenshot({ path: join(out, 'ghost-stage.png') });
    const moving = b.find((v, i) => !v.paused && v.ready >= 2 && v.w > 0 && (v.t !== a[i]?.t || v.src !== a[i]?.src));
    if (!moving) throw new Error(`no ghost video is playing: ${JSON.stringify(b)}`);
    const still = await page.locator('.ghost-figure img').count();
    if (still) throw new Error('the still image is showing instead of the video');
    return `${moving.src.replace(BASE, '')} at ${moving.t.toFixed(2)}s, ${moving.w}px`;
  });

  await step('all 14 clips and the still are served as media', async () => {
    const bad = [];
    for (const name of [...CLIPS.flatMap((c) => [`${c}.webm`, `${c}.mov`]), 'arms-open.png']) {
      const res = await page.request.get(`${BASE}/ghost/${name}`);
      const type = res.headers()['content-type'] ?? '';
      const size = (await res.body()).length;
      if (res.status() !== 200 || !/^(video|image)\//.test(type) || size < 50_000) bad.push(`${name} ${res.status()} ${type} ${size}`);
    }
    if (bad.length) throw new Error(bad.join('; '));
    return `${CLIPS.length * 2 + 1} files`;
  });

  await step('every clip decodes and plays in the browser', async () => {
    const report = await page.evaluate(async (clips) => Promise.all(clips.map((clip) => new Promise((done) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.src = `/ghost/${clip}.webm`;
      const end = (ok, why) => { v.remove(); done({ clip, ok, why }); };
      const timer = setTimeout(() => end(false, 'timeout'), 15_000);
      v.onerror = () => { clearTimeout(timer); end(false, 'error'); };
      v.ontimeupdate = () => { if (v.currentTime > 0.2) { clearTimeout(timer); end(true, `${v.videoWidth}px ${v.duration.toFixed(1)}s`); } };
      v.play().catch((e) => { clearTimeout(timer); end(false, String(e)); });
    }))), CLIPS);
    const failed = report.filter((r) => !r.ok);
    if (failed.length) throw new Error(JSON.stringify(failed));
    return report.map((r) => `${r.clip} ${r.why}`).join(', ');
  });

  await step('no /ghost/ request failed', async () => {
    const failed = ghostResponses.filter((r) => r.status >= 400);
    if (failed.length) throw new Error(JSON.stringify(failed));
    return `${ghostResponses.length} requests`;
  });

  await step('menu: Workspace, then Admin; no Home or Talk', async () => {
    await page.click('button[aria-label^="Open menu"]');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, 'menu.png') });
    const headings = await page.locator('nav[aria-label="Pages"] h2').allInnerTexts();
    const links = await page.locator('nav[aria-label="Pages"] a').allInnerTexts();
    const names = headings.map((h) => h.replace(/Owner/, '').trim());
    if (names[0] !== 'Workspace' || names[1] !== 'Admin') throw new Error(`sections are ${JSON.stringify(names)}`);
    const banned = links.map((l) => l.trim()).filter((l) => /^(Home|Talk)$/i.test(l));
    if (banned.length) throw new Error(`menu still has ${banned.join(', ')}`);
    return `${names.join(' > ')}; ${links.map((l) => l.trim()).join(', ')}`;
  });
} finally {
  await browser.close();
  console.log(JSON.stringify({ screenshots: out, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok])) }));
  process.exitCode = Object.values(results).every((r) => r.ok) ? 0 : 1;
}
