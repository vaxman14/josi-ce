// The page agent in a real Chromium page: password and payment fields are
// never listed or filled, and drop-downs, rich editors, shadow DOM and
// same-origin frames work. The extension API is a stub that records nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const agent = readFileSync(join(import.meta.dirname, '../src/page-agent.js'), 'utf8');
const PAGE = `<!doctype html><html><body>
  <h1>Garage sale</h1>
  <label>Title <input name="title"></label>
  <label>Password <input type="password" name="pw"></label>
  <label>Card <input name="cardNumber"></label>
  <label>Number <input autocomplete="cc-number" name="n1"></label>
  <label>Code <input id="cvv"></label>
  <label>Sign-in code <input autocomplete="one-time-code" name="otp"></label>
  <label>Category <select name="category"><option value="">Choose</option><option value="f">Furniture</option><option value="t">Tools</option><option value="x" disabled>Sold out</option></select></label>
  <div contenteditable="true" aria-label="Description"></div>
  <div id="host"></div>
  <iframe id="frame" srcdoc="<label>Price <input name=price></label><input type=password name=secret>" style="width:300px;height:80px"></iframe>
  <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow publish</button>';</script>
</body></html>`;

let browser: Browser, page: Page;
beforeAll(async () => {
  // Playwright's own Chromium when installed, otherwise the installed Chrome.
  browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  page = await browser.newPage();
  // A secure origin, as on a real site (crypto.randomUUID needs one).
  await page.route('https://garage.example.test/**', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('https://garage.example.test/listing');
  await page.waitForFunction(() => (document.querySelector('#frame') as HTMLIFrameElement).contentDocument?.querySelector('input'));
  await page.evaluate(source => {
    const listeners: ((request: unknown, sender: unknown, respond: (v: unknown) => void) => boolean)[] = [];
    (globalThis as any).chrome = { runtime: { id: 'test', onMessage: { addListener: (f: any) => listeners.push(f) }, sendMessage: async () => ({}) } };
    (globalThis as any).__josiPageAgentTest = {};
    (globalThis as any).__send = (request: Record<string, unknown>) => new Promise(resolve => listeners[0]({
      version: 1, channel: 'josi-page', sessionId: '6f1c3c4e-8f3e-4c1e-9a55-1b0e0c7d2a11', expectedUrl: location.href, expiresAt: Date.now() + 10000, ...request }, { id: 'test' }, resolve));
    new Function(source)();
  }, agent);
}, 120_000);
afterAll(async () => { await browser?.close(); });

type Observation = { observationId: string; elements: { id: string; role: string; name: string; inputType: string | null; options?: string[]; inFrame?: boolean }[]; crossOriginFrames: number };
const send = (request: Record<string, unknown>) => page.evaluate(r => (globalThis as any).__send(r), request) as Promise<any>;
const read = () => send({ kind: 'observe', maxOutputBytes: 60000 }) as Promise<Observation>;

describe('page agent', () => {
  it('never lists password, payment or one-time-code fields, in the page or in a frame', async () => {
    const seen = await read();
    const names = seen.elements.map(e => e.name);
    expect(names).toContain('Title');
    for (const hidden of ['Password', 'Card', 'Number', 'Code', 'Sign-in code']) expect(names).not.toContain(hidden);
    expect(seen.elements.some(e => e.inputType === 'password')).toBe(false);
    expect(seen.elements.filter(e => e.inFrame).map(e => e.name)).toEqual(['Price']);
  });
  it('finds elements in open shadow roots and lists a drop-down\'s options', async () => {
    const seen = await read();
    expect(seen.elements.some(e => e.name === 'Shadow publish')).toBe(true);
    const select = seen.elements.find(e => e.role === 'select')!;
    expect(select.options).toEqual(['Choose', 'Furniture', 'Tools', 'Sold out']);
  });
  it('chooses an option by its text and refuses a disabled or unknown one', async () => {
    let seen = await read();
    let select = seen.elements.find(e => e.role === 'select')!;
    expect(await send({ kind: 'select', observationId: seen.observationId, elementId: select.id, value: 'tools' })).toMatchObject({ kind: 'input_issued', chosen: 'Tools' });
    expect(await page.evaluate(() => (document.querySelector('select') as HTMLSelectElement).value)).toBe('t');
    seen = await read(); select = seen.elements.find(e => e.role === 'select')!;
    expect(await send({ kind: 'select', observationId: seen.observationId, elementId: select.id, value: 'Sold out' })).toEqual({ kind: 'refused', code: 'option_not_found' });
    seen = await read(); select = seen.elements.find(e => e.role === 'select')!;
    expect(await send({ kind: 'select', observationId: seen.observationId, elementId: select.id, value: 'Boats' })).toEqual({ kind: 'refused', code: 'option_not_found' });
  });
  it('fills a rich editor and a field inside a same-origin frame', async () => {
    let seen = await read();
    const editor = seen.elements.find(e => e.role === 'editor')!;
    expect(await send({ kind: 'fill', observationId: seen.observationId, elementId: editor.id, value: 'Oak table, light scratches' })).toMatchObject({ kind: 'input_issued' });
    expect(await page.evaluate(() => (document.querySelector('[contenteditable]') as HTMLElement).innerText)).toContain('Oak table');
    seen = await read();
    const price = seen.elements.find(e => e.name === 'Price')!;
    expect(await send({ kind: 'fill', observationId: seen.observationId, elementId: price.id, value: '40' })).toMatchObject({ kind: 'input_issued' });
    expect(await page.evaluate(() => ((document.querySelector('#frame') as HTMLIFrameElement).contentDocument!.querySelector('input[name=price]') as HTMLInputElement).value)).toBe('40');
  });
  it('refuses to fill a password field even when named directly', async () => {
    const exports = await page.evaluate(() => {
      const t = (globalThis as any).__josiPageAgentTest.exports;
      return ['input[type=password]', 'input[name=cardNumber]', 'input[autocomplete=cc-number]', '#cvv', 'input[name=title]'].map(s => t.sensitive(document.querySelector(s)));
    });
    expect(exports).toEqual([true, true, true, true, false]);
  });
  it('needs a fresh read: an old observation cannot act twice', async () => {
    const seen = await read();
    const title = seen.elements.find(e => e.name === 'Title')!;
    expect(await send({ kind: 'fill', observationId: seen.observationId, elementId: title.id, value: 'Lamp' })).toMatchObject({ kind: 'input_issued' });
    expect(await send({ kind: 'fill', observationId: seen.observationId, elementId: title.id, value: 'Lamp' })).toEqual({ kind: 'refused', code: 'observation_changed' });
  });
});
