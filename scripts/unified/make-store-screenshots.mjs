// Renders the real extension popup in a few states and places each on a
// 1280x800 branded frame for the store listings.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
const dataUrl = file => 'data:image/png;base64,' + readFileSync(file).toString('base64');
const [repo, out] = process.argv.slice(2);
const { chromium } = createRequire(join(repo, 'package.json'))('playwright');
const src = join(repo, 'apps/browser-extension/src');
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

async function popup(state, file) {
  const page = await browser.newPage({ viewport: { width: 300, height: 360 }, deviceScaleFactor: 2 });
  await page.addInitScript(s => {
    globalThis.chrome = { runtime: { sendMessage: async () => s }, permissions: { request: async () => true } };
  }, state);
  await page.goto(pathToFileURL(join(src, 'popup.html')).href);
  await page.waitForFunction(() => !document.querySelector('#status').textContent.startsWith('Checking'));
  const height = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 300, height });
  await page.screenshot({ path: file });
  await page.close();
}
const base = { family: 'chrome', origin: 'https://www.mercari.com', tabId: 1, attachedHere: true, attached: true, asked: false, canAttach: false, canStop: true, canResume: false };
await popup({ ...base, phase: 'attached', status: 'Josi uses the tab you are looking at (or one it opened), only with your permissions in Josi.' }, join(out, 'popup-working.png'));
await popup({ ...base, phase: 'stopped', status: 'You have control. Josi will not use this browser until you resume.', canStop: false, canResume: true }, join(out, 'popup-stopped.png'));

const frames = [
  { file: 'screenshot-1-uses-your-browser.png', popup: 'popup-working.png', title: 'Josi uses your browser for you',
    lines: ['Ask in Josi’s chat: “what’s on this page?”, “open mercari.com”, “describe each photo”.',
      'Josi reads the tab you are looking at, opens pages, and fills, clicks and uploads when you allow it.',
      'Works in Chrome, Edge, Brave and Firefox, with the Josi app on the same computer.'] },
  { file: 'screenshot-2-you-stay-in-charge.png', popup: 'popup-stopped.png', title: 'You stay in charge',
    lines: ['Every site and action follows the permissions you set in Josi, or asks you first.',
      'Never reads or fills passwords, payment details or one-time codes.',
      '“Take control” stops Josi in this browser at once; Pause and Stop in Josi stop everything.'] },
];
const icon = dataUrl(join(src, 'icons/icon-128.png'));
for (const f of frames) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const shot = dataUrl(join(out, f.popup));
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;width:1280px;height:800px;font-family:"Segoe UI",sans-serif;color:#f3ecf7;
      background:radial-gradient(1200px 700px at 20% 0%,#4a2660,#1b1022 70%);display:flex;align-items:center;gap:72px;padding:0 96px;box-sizing:border-box}
    .text{flex:1} .brand{display:flex;align-items:center;gap:14px;color:#eec978;font-size:28px;font-weight:600;margin-bottom:36px}
    .brand img{width:52px;height:52px;border-radius:12px} h1{font-size:52px;line-height:1.1;margin:0 0 28px;color:#fff}
    li{font-size:23px;line-height:1.45;margin:0 0 16px;color:#e2d6ec} ul{padding-left:26px;margin:0}
    .shot{width:420px;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(238,201,120,.35)}
  </style></head><body><div class="text"><div class="brand"><img src="${icon}">Josi Browser Control</div>
    <h1>${f.title}</h1><ul>${f.lines.map(l => `<li>${l}</li>`).join('')}</ul></div>
    <img class="shot" src="${shot}"></body></html>`);
  await page.waitForLoadState('load');
  await page.screenshot({ path: join(out, f.file) });
  await page.close();
}
await browser.close();
console.log('ok');
