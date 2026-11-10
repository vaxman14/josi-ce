import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb } from '../../core/test/helpers.js';
import { LOCAL_WINDOWS_PC, MasterKey, PcControl, type Db, type PcBrowserPresence } from '@josi-ce/core';
import { browserToolsFor, executePcBrowserTool, pcBrowserPrompt, PC_BROWSER_LINKED_PROMPT, PC_BROWSER_PROMPT, PC_BROWSER_TOOL_NAMES } from '../src/pcBrowserTools.js';

const key = new MasterKey(Buffer.alloc(32, 7));
const linked: PcBrowserPresence = { family: 'chrome', application: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile: 'Default',
  origin: null, title: null, activeTabId: 41, activeOrigin: 'https://shop.example.test', activeTitle: 'Garage sale',
  tabs: [{ tabId: 41, origin: 'https://shop.example.test', title: 'Garage sale', active: true }, { tabId: 7, origin: 'https://mail.example.test', title: 'Mail', active: false }] };
const attached: PcBrowserPresence = { ...linked, origin: 'https://shop.example.test', title: 'Garage sale' };
const names = (p: PcBrowserPresence | null) => browserToolsFor(p).map(t => t.def.name).sort();

describe('browser tool availability', () => {
  it('offers only linking tools while no tab is attached, and the full set once one is', () => {
    expect(names(linked)).toEqual(['browser_attach_tab', 'browser_check_request', 'browser_list_tabs', 'browser_open_page']);
    const full = names(attached);
    for (const n of ['browser_read_page', 'browser_select_option', 'browser_drag', 'browser_download', 'browser_upload_file', 'browser_scroll', 'browser_attach_tab'])
      expect(full).toContain(n);
    expect(full.length).toBe(PC_BROWSER_TOOL_NAMES.size);
  });
  it('offers nothing for the desktop-only presence or no presence', () => {
    expect(names(null)).toEqual([]);
    expect(names({ family: 'desktop', application: 'C:\\Josi\\Josi.exe', profile: 'Default', origin: null, title: null })).toEqual([]);
  });
  it('accepts firefox as a browser family', () => {
    expect(names({ ...linked, family: 'firefox' })).toContain('browser_attach_tab');
  });
  it('picks the prompt that matches what is offered', () => {
    expect(pcBrowserPrompt(browserToolsFor(attached))).toBe(PC_BROWSER_PROMPT);
    expect(pcBrowserPrompt(browserToolsFor(linked))).toBe(PC_BROWSER_LINKED_PROMPT);
    expect(pcBrowserPrompt([])).toBe('');
  });
  it('keeps every schema closed and bounded', () => {
    for (const tool of browserToolsFor(attached)) {
      const schema = tool.def.parameters as { additionalProperties: boolean; properties: Record<string, { type: string; maxLength?: number; enum?: string[]; format?: string }> };
      expect(schema.additionalProperties).toBe(false);
      for (const p of Object.values(schema.properties)) if (p.type === 'string') expect(p.maxLength !== undefined || p.enum !== undefined || p.format === 'uuid').toBe(true);
    }
  });
});

describe('browser tools propose exact PC Control requests', () => {
  let db: Db, owner: string, control: PcControl, n = 0;
  beforeAll(async () => { db = await testDb(); });
  beforeEach(async () => {
    n++; owner = (await createUser(db, { email: `browser-${n}@example.test`, username: `browser-${n}`, role: 'member' })).id;
    control = new PcControl(db, key, LOCAL_WINDOWS_PC);
    await control.setEnabled(owner, true);
  });
  async function lastRequest() {
    // The snapshot hides payloads; an approved plan carries the exact one.
    const [row] = (await control.snapshot(owner)).requests;
    await control.decide(owner, row.id, true);
    const plan = (await control.approved(owner)).find(p => p.id === row.id)!.plan;
    return { ...row, payload: plan.payload };
  }
  const run = (name: string, input: Record<string, unknown> = {}) => {
    const result = executePcBrowserTool(db, owner, key, name, input);
    return Promise.race([result, new Promise(resolve => setTimeout(() => resolve('waiting'), 300))]);
  };

  it('lists tabs from presence without proposing anything', async () => {
    await control.setPresence(owner, linked);
    const result = await executePcBrowserTool(db, owner, key, 'browser_list_tabs', {}) as { tabs: { tab_id: number; site: string; active?: boolean }[]; attached: unknown };
    expect(result.attached).toBeNull();
    expect(result.tabs).toEqual([{ tab_id: 41, site: 'https://shop.example.test', title: 'Garage sale', active: true }, { tab_id: 7, site: 'https://mail.example.test', title: 'Mail' }]);
    expect((await control.snapshot(owner)).requests).toHaveLength(0);
  });
  it('attaches the active tab by proposing browser.view on its origin', async () => {
    await control.setPresence(owner, linked);
    await run('browser_attach_tab');
    const request = await lastRequest();
    expect(request.requirements).toEqual([{ action: 'browser.view', scope: { kind: 'browser', target: 'https://shop.example.test', application: linked.application, profile: 'Default' } }]);
    expect(request.payload).toEqual({ kind: 'attach', tabId: 41 });
  });
  it('attaches a named tab on that tab\'s own origin', async () => {
    await control.setPresence(owner, linked);
    await run('browser_attach_tab', { tab_id: 7 });
    const request = await lastRequest();
    expect(request.requirements[0].scope.target).toBe('https://mail.example.test');
    expect(request.payload).toEqual({ kind: 'attach', tabId: 7 });
  });
  it('opens a page in a new tab when no tab is attached', async () => {
    await control.setPresence(owner, linked);
    await run('browser_open_page', { url: 'https://www.mercari.com/mypage/listings/' });
    const request = await lastRequest();
    expect(request.requirements[0]).toMatchObject({ action: 'browser.view', scope: { target: 'https://www.mercari.com' } });
    expect(request.payload).toEqual({ kind: 'open', url: 'https://www.mercari.com/mypage/listings/' });
    expect(request.description).toMatch(/new tab/);
  });
  it('refuses a tab that is not open, and page tools before any tab is attached', async () => {
    await control.setPresence(owner, linked);
    expect(await executePcBrowserTool(db, owner, key, 'browser_attach_tab', { tab_id: 999 })).toMatchObject({ ok: false, code: 'tab_not_found' });
    expect(await executePcBrowserTool(db, owner, key, 'browser_read_page', {})).toMatchObject({ ok: false, code: 'no_attached_tab' });
  });
  it('requires both the upload and the folder read for an upload', async () => {
    await control.setPresence(owner, attached);
    await run('browser_upload_file', { observation_id: crypto.randomUUID(), element_id: crypto.randomUUID(), path: 'C:\\Users\\Roman\\Pictures\\lamp.jpg' });
    const request = await lastRequest();
    expect(request.requirements.map(r => r.action).sort()).toEqual(['browser.upload', 'folder.read']);
    expect(request.requirements.find(r => r.action === 'folder.read')!.scope).toEqual({ kind: 'folder', target: 'C:\\Users\\Roman\\Pictures' });
    expect(await executePcBrowserTool(db, owner, key, 'browser_upload_file', { observation_id: crypto.randomUUID(), element_id: crypto.randomUUID(), path: 'pictures\\lamp.jpg' }))
      .toMatchObject({ ok: false, code: 'invalid_path' });
  });
  it('downloads only https addresses on the attached site', async () => {
    await control.setPresence(owner, attached);
    expect(await executePcBrowserTool(db, owner, key, 'browser_download', { url: 'https://elsewhere.example.test/a.pdf' })).toMatchObject({ code: 'invalid_url' });
    expect(await executePcBrowserTool(db, owner, key, 'browser_download', { url: 'http://shop.example.test/a.pdf' })).toMatchObject({ code: 'invalid_url' });
    await run('browser_download', { url: 'https://shop.example.test/files/receipt.pdf' });
    const request = await lastRequest();
    expect(request.requirements[0].action).toBe('browser.download');
    expect(request.payload).toEqual({ kind: 'download', url: 'https://shop.example.test/files/receipt.pdf' });
  });
  it('maps select to form filling and drag to a submission', async () => {
    await control.setPresence(owner, attached);
    await run('browser_select_option', { observation_id: crypto.randomUUID(), element_id: crypto.randomUUID(), option: 'Furniture' });
    expect((await lastRequest()).requirements[0].action).toBe('browser.fill');
    await control.setPresence(owner, attached);
    await run('browser_drag', { observation_id: crypto.randomUUID(), element_id: crypto.randomUUID(), to_element_id: crypto.randomUUID() });
    const actions = (await control.snapshot(owner)).requests.map(r => r.requirements[0].action);
    expect(actions).toContain('browser.submit');
  });
});
