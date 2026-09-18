// Synthetic local browser acceptance. Never connects to a configured database,
// an external provider, an existing browser profile, or a running installation.
// Run after npm run build && npm run build --workspace=@josi-ce/web.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { chromium } from 'playwright';
import { pgliteDb, ensureWorkspace, completeSetup } from '../packages/core/dist/index.js';
import { createUser } from '../packages/auth/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';

const pg = new PGlite();
let server, browser;
const output = resolve('node_modules/.cache/migration-ui');
mkdirSync(output, { recursive: true });
try {
  for (const name of readdirSync('packages/db/migrations').filter(name => name.endsWith('.sql')).sort()) await pg.exec(readFileSync(`packages/db/migrations/${name}`, 'utf8'));
  const db = pgliteDb(pg); await ensureWorkspace(db); await completeSetup(db);
  const user = await createUser(db, { email: 'migration-ui@example.test', username: 'migration-ui', role: 'member', password: 'synthetic-ui-password-123' });
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: false, webDir: resolve('apps/web/dist') });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(edge) ? { executablePath: edge } : {}) });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await db.query('delete from memories where owner_user_id = $1', [user.id]);
    await db.query('delete from migration_batches where owner_user_id = $1', [user.id]);
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.request.get(`${base}/api/auth/csrf`);
    const cookies = await context.cookies(); const csrf = cookies.find(cookie => cookie.name === 'josi_csrf').value;
    const login = await context.request.post(`${base}/api/auth/login`, { headers: { 'x-josi-csrf': csrf }, data: { identifier: 'migration-ui', password: 'synthetic-ui-password-123' } });
    assert.equal(login.status(), 200);
    await page.goto(`${base}/app/settings`);
    await page.getByText('Data & Backup', { exact: true }).click();
    await page.getByRole('button', { name: 'Migrate from another assistant', exact: true }).click();
    await page.getByLabel('Source assistant').selectOption('openclaw');
    await page.getByLabel('Choose your ZIP, Markdown, JSON or JSONL files').setInputFiles({ name: 'MEMORY.md', mimeType: 'text/markdown', buffer: Buffer.from('- Synthetic sailing preference\n- <script>window.migrationUnsafe = true</script>') });
    await page.getByRole('button', { name: 'Scan and preview', exact: true }).click();
    await page.getByText('Dry run: nothing has been saved.', { exact: false }).waitFor();
    assert.equal((await db.query('select id from memories')).length, 0);
    await page.getByLabel('Proposed memory — edit or redact').first().fill('Synthetic edited sailing preference');
    await page.getByRole('checkbox', { name: 'Select this item', exact: true }).last().check();
    assert.equal(await page.evaluate(() => window.migrationUnsafe), undefined);
    await page.screenshot({ path: `${output}/${viewport.width}-preview.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
    await page.getByRole('button', { name: 'Review 2 selected items', exact: true }).click();
    await page.getByRole('button', { name: 'Import 2 reviewed items', exact: true }).waitFor();
    assert.equal((await db.query('select id from memories')).length, 0);
    await page.getByRole('button', { name: 'Import 2 reviewed items', exact: true }).click();
    await page.getByText('Import completed. 2 new rows saved.', { exact: true }).waitFor();
    assert.equal((await db.query('select id from memories')).length, 2);
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download receipt', exact: true }).click();
    const receipt = await download; assert.match(receipt.suggestedFilename(), /^josi-migration-/);
    await page.getByRole('button', { name: 'Roll back batch', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm rollback', exact: true }).click();
    await page.getByText('Rollback completed. 2 rows removed.', { exact: true }).waitFor();
    assert.equal((await db.query('select id from memories')).length, 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${viewport.width}px: upload, escaped preview, memory edit, review, commit, receipt, rollback, no overflow or page errors`);
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await pg.close();
}
