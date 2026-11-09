import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeServerKey, Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await new Harness().start(); });
afterAll(() => h.stop());

const codeFor = (secret: string, offset = 0) => generate({ secret, epoch: Math.floor(h.ctx.now() / 1000) + offset });
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

async function linked() {
  const account = await h.account();
  const server = new FakeServerKey(h);
  await server.link(account.browser);
  return { account, server };
}
async function turnOn(account: Awaited<ReturnType<Harness['account']>>) {
  const secret = (await account.browser.post('/api/2fa/begin', { password: account.password })).body.secret as string;
  expect((await account.browser.post('/api/2fa/enable', { code: await codeFor(secret) })).status).toBe(200);
  h.offset += 60_000;
  return secret;
}

describe('sharing the authenticator with a linked server', () => {
  it('hands the secret over for a live code, and nothing else', async () => {
    const { account, server } = await linked();
    const secret = await turnOn(account);
    expect(await server.call({ op: 'totp.share', code: wrong(await codeFor(secret)) })).toMatchObject({ ok: false, error: 'bad_code' });
    expect(await server.call({ op: 'totp.share', code: 'ABCDEF' })).toMatchObject({ ok: false, error: 'bad_code' });
    expect(await server.call({ op: 'totp.share', code: await codeFor(secret) })).toMatchObject({ ok: true, secret });
  });

  it('will not spend a recovery code on it', async () => {
    const { account, server } = await linked();
    const begin = await account.browser.post('/api/2fa/begin', { password: account.password });
    const enabled = await account.browser.post('/api/2fa/enable', { code: await codeFor(begin.body.secret as string) });
    const [recovery] = enabled.body.recoveryCodes as string[];
    expect(await server.call({ op: 'totp.share', code: recovery! })).toMatchObject({ ok: false, error: 'bad_code' });
  });

  it('says so when the account has no authenticator', async () => {
    const { server } = await linked();
    expect(await server.call({ op: 'totp.share', code: '123456' })).toMatchObject({ ok: false, error: 'no_totp' });
  });

  it('gives a server nothing from another account', async () => {
    const one = await linked(), other = await linked();
    const secret = await turnOn(one.account);
    expect(await other.server.call({ op: 'totp.share', code: await codeFor(secret) })).toMatchObject({ ok: false, error: 'no_totp' });
  });

  it('refuses a server that is not linked', async () => {
    expect(await new FakeServerKey(h).call({ op: 'totp.share', code: '123456' })).toMatchObject({ ok: false, error: 'unknown_server' });
  });
});
