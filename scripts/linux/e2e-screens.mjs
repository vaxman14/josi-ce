#!/usr/bin/env node
// Browser pass over an installed Josi, after scripts/linux/e2e-fake.mjs:
// signs in through the real login page with the saved test account (password
// plus authenticator code), chats on the Ghost Stage with the fake model, and
// optionally presses the one-click update in System checkup.
//
//   sudo node scripts/linux/e2e-screens.mjs <screenshot dir> [--update]
//
// Runs on the Josi machine against its own loopback address. Needs Playwright
// (PLAYWRIGHT_PATH, default the repo's node_modules) and its Chromium. The
// credentials come from /root/josi-e2e-credentials.json and are never printed.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { RESULT_MARKER, startFakeModel } from './e2e-fake-model.mjs';

// Josi's own public port: another program may hold 8080 (it does on the Ubuntu test box).
const BASE = process.env.E2E_BASE
  ?? `http://127.0.0.1:${JSON.parse(readFileSync('/var/lib/josi/data/config/runtime.json', 'utf8')).publicPort}`;
const [out = '/tmp/josi-screens', flag] = process.argv.slice(2);
const update = flag === '--update';
const require = createRequire(resolve(process.env.PLAYWRIGHT_PATH ?? join(import.meta.dirname, '../../node_modules')) + '/');
const { chromium } = require('playwright');
const creds = JSON.parse(readFileSync('/root/josi-e2e-credentials.json', 'utf8'));
mkdirSync(out, { recursive: true });

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
  catch (error) { results[name] = { ok: false, detail: String(error?.message ?? error).slice(0, 400) }; }
  console.log(`${results[name].ok ? 'PASS' : 'FAIL'} ${name}${results[name].detail ? ' - ' + results[name].detail : ''}`);
  return results[name].ok;
};

const fake = await startFakeModel({ port: Number(process.env.E2E_FAKE_PORT ?? 18999) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
try {
  await step('login page: password then authenticator code', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#identifier', creds.username);
    await page.fill('#password', creds.password);
    await page.click('button[type=submit]:has-text("Sign in")');
    await page.getByText('One more step').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(out, 'login-authenticator.png') });
    // A code close to the end of its 30 s window can expire in flight.
    if (Date.now() / 1000 % 30 > 25) await page.waitForTimeout(6_000);
    await page.locator('form input').first().click();
    await page.keyboard.type(totp(creds.totpSecret), { delay: 40 });
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
    return `landed on ${new URL(page.url()).pathname}`;
  });

  await step('Ghost Stage chat with a tool call', async () => {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: join(out, 'ghost-stage-idle.png') });
    const mark = fake.requests.length;
    await page.fill('[aria-label="Message Josi"]', 'E2E_CALL_TOOL What is on my task list?');
    await page.click('[aria-label="Send message"]');
    // While Josi works, the stage shows what she is doing (the turn's live
    // status), not just a wait. The reply of an earlier run may already be on
    // screen, so the end is the model receiving this turn's tool result.
    const lines = new Set();
    const finished = () => fake.requests.slice(mark).some((r) => r.seen?.toolResults?.length);
    const started = Date.now();
    while (!(process.env.E2E_REMOTE_MODEL === '1' ? Date.now() - started > 8_000 : finished()) && Date.now() - started < 90_000) {
      const line = (await page.locator('.stage-text').first().innerText().catch(() => '')).trim();
      if (line) lines.add(line);
      if (lines.size >= 2 && !(await page.locator('[data-shot-working]').count())) { await page.screenshot({ path: join(out, 'ghost-stage-working.png') }); await page.evaluate(() => document.body.setAttribute('data-shot-working', '1')); }
      await page.waitForTimeout(200);
    }
    console.log('stage lines while working:', JSON.stringify([...lines]));
    await page.getByText(RESULT_MARKER, { exact: false }).first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(4_000); // let the word-by-word reveal finish
    await page.screenshot({ path: join(out, 'ghost-stage-reply.png') });
    // E2E_REMOTE_MODEL=1: the browser runs on another machine than Josi and
    // its fake model, so only the page itself is checked.
    if (process.env.E2E_REMOTE_MODEL === '1') return 'reply with the tool result shown on the stage';
    const seen = fake.requests.slice(mark);
    const called = seen.find((r) => r.answer?.tool)?.answer.tool.name;
    if (!called || !seen.some((r) => r.seen?.toolResults?.length)) throw new Error('the fake model never received a tool result');
    return `${seen.length} model requests; Josi ran ${called} and returned its result`;
  });

  await step('History panel', async () => {
    await page.click('button[aria-label^="Open chat history"]');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, 'ghost-stage-history.png') });
    await page.keyboard.press('Escape');
  });

  await step('a settings card on the stage', async () => {
    const local = await page.evaluate(async () => (await (await fetch('/api/admin/pc-control/local')).json()));
    const pcId = local.executors?.[0]?.pcId;
    if (!pcId) throw new Error('no PC service on this server');
    const input = { area: 'pc_control_full_control', summary: 'Stop the everyday allowances on this server.', params: { pcId }, body: { enabled: false } };
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await page.fill('[aria-label="Message Josi"]', `Please turn off everyday control. E2E_TOOL:propose_josi_setting_change:${JSON.stringify(input)}`);
    await page.click('[aria-label="Send message"]');
    await page.getByRole('button', { name: /decline/i }).first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(out, 'ghost-stage-card.png') });
    await page.getByRole('button', { name: /decline/i }).first().click();
    return 'the card appeared on the stage, under the reply, and was declined';
  });

  await step('a sign-in card opens the live view of her browser, and Done closes it', async () => {
    const input = { mode: 'browser', title: 'UI test site', why: 'to check the live view in a real browser' };
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await page.fill('[aria-label="Message Josi"]', `Please sign in for me. E2E_TOOL:request_sign_in:${JSON.stringify(input)}`);
    await page.click('[aria-label="Send message"]');
    const open = page.getByRole('button', { name: 'Open', exact: true }).first();
    await open.waitFor({ timeout: 90_000 });
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: join(out, 'sign-in-card.png') });
    const answers = [];
    page.on('response', (r) => { if (r.url().includes('/api/live-signin')) answers.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
    await open.click();
    const panel = page.getByTestId('josi.live-signin');
    try { await panel.waitFor({ timeout: 20_000 }); }
    catch (error) {
      await page.screenshot({ path: join(out, 'sign-in-failed.png') });
      const alerts = await page.locator('[role=alert]').allInnerTexts().catch(() => []);
      throw new Error(`the panel never opened. Server answers: ${JSON.stringify(answers)}; alerts: ${JSON.stringify(alerts)}; ${String(error.message).slice(0, 80)}`);
    }
    const picture = panel.locator('img').first();
    await picture.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => { const i = document.querySelector('[data-testid="josi.live-signin"] img'); return i && i.naturalWidth > 200; }, null, { timeout: 30_000 });
    const privacy = await panel.getByTestId('josi.live-signin.privacy').innerText();
    if (!/never sees/i.test(privacy)) throw new Error('the panel does not say Josi never sees the screen: ' + privacy);
    await page.screenshot({ path: join(out, 'sign-in-live-view.png') });
    // Typing into the panel reaches the page: the "Type here" box sends it.
    await panel.getByLabel('Type here, then press Send').fill('hello');
    await panel.getByRole('button', { name: /^send$/i }).click();
    await page.waitForTimeout(1_000);
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    await panel.waitFor({ state: 'detached', timeout: 20_000 });
    return 'card on the stage, Open showed a live picture, typing was accepted, Done closed it';
  });

  for (const [name, path] of [['my-world', '/app/my-world'], ['pc-control', '/admin/pc-control'], ['network', '/admin/network'], ['setup-menu', '/app/tasks']]) {
    await step(`page ${path}`, async () => {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
      const text = await page.locator('main').innerText().catch(() => '');
      if (/something went wrong|unexpected error/i.test(text)) throw new Error('the page shows an error');
      return `${text.split(String.fromCharCode(10)).filter(Boolean).slice(0, 3).join(' | ').slice(0, 160)}`;
    });
  }

  await step('phone width', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: join(out, 'ghost-stage-phone.png') });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) throw new Error('the page scrolls sideways at 390px');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('System checkup page', async () => {
    await page.goto(`${BASE}/admin/diagnostics`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(out, 'system-checkup.png'), fullPage: true });
  });

  if (update) {
    await step('one-click update', async () => {
      const before = (await (await page.request.get(`${BASE}/api/admin/doctor/update`)).json()).currentVersion;
      await page.goto(`${BASE}/admin/diagnostics`, { waitUntil: 'networkidle' });
      await page.click('button:has-text("Check for updates")');
      // Read the offer only after the fresh check answers, not the stored one.
      await page.locator('button:has-text("Check for updates"):not([disabled])').waitFor({ timeout: 60_000 });
      const button = page.locator('button', { hasText: /^Update to / });
      await button.waitFor({ timeout: 60_000 });
      await page.screenshot({ path: join(out, 'update-available.png') });
      const target = (await button.textContent()).replace('Update to ', '').trim();
      await button.click();
      await page.getByText(`Updating to ${target}`).waitFor({ timeout: 30_000 });
      await page.screenshot({ path: join(out, 'update-running.png') });
      // The services restart underneath the page; it polls and reconnects.
      const deadline = Date.now() + 15 * 60_000;
      let now = before;
      while (Date.now() < deadline) {
        await page.waitForTimeout(5_000);
        try {
          const res = await page.request.get(`${BASE}/api/admin/doctor/update`, { timeout: 5_000 });
          if (res.ok()) { const value = await res.json(); now = value.currentVersion; if (now === target && value.job.state === 'complete') break; }
        } catch { /* restarting */ }
      }
      if (now !== target) throw new Error(`still on ${now} after waiting`);
      await page.goto(`${BASE}/admin/diagnostics`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: join(out, 'update-complete.png') });
      return `${before} -> ${now}`;
    });
  }
} finally {
  await browser.close();
  await fake.close?.();
  console.log(JSON.stringify({ screenshots: out, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok])) }));
  process.exitCode = Object.values(results).every((r) => r.ok) ? 0 : 1;
}
