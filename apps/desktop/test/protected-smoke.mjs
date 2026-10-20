import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url)), executablePath = process.argv[2];
assert(executablePath, 'Pass the verified Electron executable as argv[2]');
const output = resolve(root, 'build/unified-p4'); await mkdir(output, { recursive: true });
const application = await _electron.launch({ executablePath, args: [resolve(root, 'apps/desktop/test/protected-smoke-host.cjs')], cwd: root,
  chromiumSandbox: true, acceptDownloads: false, timeout: 30000 });
try {
  const parent = await application.firstWindow();
  await parent.getByRole('heading', { name: 'Protected confirmation test host' }).waitFor();
  async function start(options = {}) {
    const opened = application.waitForEvent('window');
    await application.evaluate((_electron, values) => globalThis.protectedFixture.start(values), options);
    const page = await opened; await page.getByRole('heading', { name: 'Make this Cardinal Rule permanent' }).waitFor(); return page;
  }
  async function settled() {
    for (let i = 0; i < 100; i++) {
      const state = await application.evaluate(() => globalThis.protectedFixture.inspect());
      if (state.result) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Fixture confirmation did not settle.');
  }
  const page = await start();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.josiDesktop), 'undefined');
  assert.deepEqual(await page.evaluate(() => Object.keys(window.josiProtected).sort()), ['decide', 'onState', 'state']);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert((await page.locator('#wording').textContent()).includes('<script>window.injected = true</script>'));
  await assert.rejects(parent.evaluate(() => window.josiProtected.state()));
  assert.equal(await page.evaluate(async () => { try { await fetch('https://example.invalid'); return 'unexpected'; } catch { return 'blocked'; } }), 'blocked');
  assert.equal(await page.getByRole('button', { name: 'Confirm with Touch ID' }).isDisabled(), true);
  await page.screenshot({ path: resolve(output, 'protected-confirmation.png') });
  await page.getByLabel('I have reviewed the change and its meaning.').check();
  await page.getByRole('button', { name: 'Confirm with Touch ID' }).click();
  await page.getByText('Use the macOS Touch ID prompt to confirm. You can still cancel this change.').waitFor();
  assert.equal((await application.evaluate(() => globalThis.protectedFixture.inspect())).signatures, 0);
  await application.evaluate(() => globalThis.protectedFixture.finishAuthentication());
  const confirmed = await settled(); assert.equal(confirmed.result.status, 'confirmed'); assert.equal(confirmed.verified, true);
  assert.equal(confirmed.authCalls, 1); assert.equal(confirmed.signatures, 1);

  const cancelled = await start();
  await cancelled.getByLabel('I have reviewed the change and its meaning.').check();
  await cancelled.getByRole('button', { name: 'Confirm with Touch ID' }).click();
  await cancelled.getByText('Use the macOS Touch ID prompt to confirm. You can still cancel this change.').waitFor();
  await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await settled()).result.status, 'refused');
  await application.evaluate(() => globalThis.protectedFixture.finishAuthentication());
  assert.equal((await application.evaluate(() => globalThis.protectedFixture.inspect())).signatures, 1);

  const afterPresence = await start({ holdAfterAuthentication: true });
  await afterPresence.getByLabel('I have reviewed the change and its meaning.').check();
  await afterPresence.getByRole('button', { name: 'Confirm with Touch ID' }).click();
  await afterPresence.getByText('Use the macOS Touch ID prompt to confirm. You can still cancel this change.').waitFor();
  await application.evaluate(() => globalThis.protectedFixture.finishAuthentication());
  await afterPresence.getByText('Identity verified. Finishing this confirmation…').waitFor();
  await afterPresence.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await settled()).result.status, 'refused');
  await application.evaluate(() => globalThis.protectedFixture.finishCheck());
  assert.equal((await application.evaluate(() => globalThis.protectedFixture.inspect())).signatures, 1);

  const unsupported = await start({ supported: false });
  await unsupported.getByText('Touch ID is unavailable on this Mac. This change cannot be confirmed here yet.').waitFor();
  assert.equal(await unsupported.getByRole('button', { name: 'Confirm with Touch ID' }).isDisabled(), true);
  await unsupported.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal((await settled()).result.status, 'refused');
  const lost = await start(), closed = lost.waitForEvent('close');
  await application.evaluate(() => globalThis.protectedFixture.cancel()); await closed;
  assert.equal((await settled()).result.status, 'refused');
  const result = { passed: true, runtime: 'Electron 43.2.0', syntheticOnly: true,
    osAuthentication: 'fixture only; no biometric prompt', signingKey: 'in-memory fixture only',
    checks: ['plain-text-exact-presentation', 'renderer-sandbox', 'foreign-window-IPC-denial', 'no-network',
      'review-before-OS-presence', 'signature-after-presence-only', 'cancel-late-presence', 'cancel-after-presence',
      'unsupported-presence-refusal', 'connection-loss-cancellation'] };
  await writeFile(resolve(output, 'protected-confirmation-smoke.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await application.close(); }
