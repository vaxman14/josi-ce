// App Store Connect and Google Play: the key is checked, never trusted.
//
// Every key here is generated when the suite runs, so nothing credential-shaped
// is committed and the signatures can be verified against the matching public
// half. No test reaches Apple or Google: each one hands in its own fetch.
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVELOPER_SERVICE_CATALOG, checkDeveloperCredentials, checkDeveloperToken, developerServiceFields,
  listDeveloperResourcesFor, mintAppStoreConnectToken, normalizeDeveloperFields, normalizePem,
} from '../src/developerServices.js';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const ISSUER = '57246542-96fe-1a63-e053-0824d011072a';
const KEY_ID = 'ABC123DEFG';
const PACKAGE = 'com.example.app';
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account', project_id: 'fixture-project', private_key_id: 'fixture-key-id', private_key: RSA_PEM,
  client_email: 'josi-reader@fixture-project.iam.gserviceaccount.com',
  // A pasted file names its own token endpoint. It must never be used.
  token_uri: 'https://attacker.invalid/token',
}, null, 2);

const apple = { issuerId: ISSUER, keyId: KEY_ID, privateKey: P8 };
const google = { serviceAccountJson: SERVICE_ACCOUNT, packageName: PACKAGE };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const bodyOf = (p8: string) => p8.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

function fields(service: 'appstoreconnect' | 'googleplay', body: unknown) {
  const result = normalizeDeveloperFields(service, body);
  if (!result.ok) throw new Error(result.detail);
  return result.values;
}

describe('the catalog lists every form as fields', () => {
  it('derives the fields of the single-token services from their labels', () => {
    const by = new Map(DEVELOPER_SERVICE_CATALOG.map((d) => [d.service, developerServiceFields(d)]));
    expect(by.get('github')).toEqual([{ key: 'token', label: 'Personal access token', secret: true, multiline: false, help: expect.any(String) }]);
    expect(by.get('dockerhub')!.map((f) => f.key)).toEqual(['username', 'token']);
    expect(by.get('jira')!.map((f) => f.key)).toEqual(['email', 'baseUrl', 'token']);
    for (const [service, list] of by) {
      expect(list.length, service).toBeGreaterThan(0);
      for (const f of list) expect(Object.keys(f).sort(), service).toEqual(['help', 'key', 'label', 'multiline', 'secret']);
      // Exactly the secret parts are marked secret, and every form has one.
      expect(list.some((f) => f.secret), service).toBe(true);
    }
  });

  it('declares the store keys exactly', () => {
    const by = new Map(DEVELOPER_SERVICE_CATALOG.map((d) => [d.service, developerServiceFields(d)]));
    expect(by.get('appstoreconnect')!.map(({ key, label, secret, multiline }) => ({ key, label, secret, multiline }))).toEqual([
      { key: 'issuerId', label: 'Issuer ID', secret: false, multiline: false },
      { key: 'keyId', label: 'Key ID', secret: false, multiline: false },
      { key: 'privateKey', label: 'Private key (.p8)', secret: true, multiline: true },
    ]);
    expect(by.get('googleplay')!.map(({ key, label, secret, multiline }) => ({ key, label, secret, multiline }))).toEqual([
      { key: 'serviceAccountJson', label: 'Service account JSON', secret: true, multiline: true },
      { key: 'packageName', label: 'Package name', secret: false, multiline: false },
    ]);
  });
});

describe('pasted keys are tidied before anything else', () => {
  it('reads the same .p8 with Windows line endings, escaped line breaks, or flattened onto one line', () => {
    const canonical = normalizePem(P8);
    expect(normalizePem(P8.replace(/\n/g, '\r\n'))).toBe(canonical);
    expect(normalizePem(`  \n${P8.trim().replace(/\n/g, '\\n')}  `)).toBe(canonical);
    expect(normalizePem(P8.trim().replace(/\n/g, ' '))).toBe(canonical);
    expect(normalizePem(bodyOf(P8))).toBe(canonical);
    expect(normalizePem('not a key at all!')).toBe('');
  });

  it('trims the plain fields and accepts them nested under `fields` too', () => {
    const values = fields('appstoreconnect', { issuerId: `  ${ISSUER.toUpperCase()}\r\n`, keyId: ' abc123defg ', privateKey: P8.replace(/\n/g, '\r\n') });
    expect(values).toEqual({ issuerId: ISSUER, keyId: KEY_ID, privateKey: normalizePem(P8) });
    expect(fields('appstoreconnect', { fields: apple })).toEqual(values);
    expect(fields('googleplay', { serviceAccountJson: `\r\n${SERVICE_ACCOUNT.replace(/\n/g, '\r\n')}\r\n`, packageName: ` ${PACKAGE}\n` }).packageName).toBe(PACKAGE);
  });

  it('keeps only what signing needs from the service account file', () => {
    const kept = JSON.parse(fields('googleplay', google).serviceAccountJson!);
    expect(Object.keys(kept).sort()).toEqual(['client_email', 'private_key', 'private_key_id', 'project_id', 'type']);
    expect(JSON.stringify(kept)).not.toContain('attacker.invalid');
  });

  it.each([
    ['a missing issuer', { ...apple, issuerId: '' }, /Issuer ID is required/],
    ['a misshapen issuer', { ...apple, issuerId: 'not-an-issuer' }, /Issuer ID is not the right shape/],
    ['a misshapen key id', { ...apple, keyId: 'has spaces!' }, /Key ID is not the right shape/],
    ['a key that is not a key', { ...apple, privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, /could not be read/],
    ['the wrong kind of key', { ...apple, privateKey: RSA_PEM }, /not an App Store Connect API key/],
  ])('refuses %s before any request, without quoting the key', (_name, body, message) => {
    const result = normalizeDeveloperFields('appstoreconnect', body);
    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(message) });
    expect(JSON.stringify(result)).not.toContain(bodyOf(P8).slice(0, 24));
  });

  it.each([
    ['text that is not JSON', { ...google, serviceAccountJson: 'definitely not json' }, /not valid JSON/],
    ['JSON that is not a service account', { ...google, serviceAccountJson: JSON.stringify({ type: 'authorized_user', client_id: 'x' }) }, /not a service account key/],
    ['a file with no private key', { ...google, serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'a@b.test' }) }, /incomplete/],
    ['a file whose key is unreadable', { ...google, serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'a@b.test', private_key: 'garbage' }) }, /could not be read/],
    ['a misshapen package name', { ...google, packageName: 'My App' }, /package name is not the right shape/],
    ['a missing package name', { ...google, packageName: '' }, /package name is required/],
  ])('refuses %s before any request, without quoting the key', (_name, body, message) => {
    const result = normalizeDeveloperFields('googleplay', body);
    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(message) });
    expect(JSON.stringify(result)).not.toContain(bodyOf(RSA_PEM).slice(0, 24));
  });

  it('still reads an original token body exactly as before', () => {
    expect(normalizeDeveloperFields('github', { token: 'fixture-token' })).toEqual({ ok: true, values: { token: 'fixture-token', username: '', email: '', baseUrl: '' } });
    expect(normalizeDeveloperFields('jira', { token: 't', email: ' a@b.test ', baseUrl: ' https://x.atlassian.net ' }))
      .toEqual({ ok: true, values: { token: 't', username: '', email: 'a@b.test', baseUrl: 'https://x.atlassian.net' } });
    expect(normalizeDeveloperFields('github', {})).toEqual({ ok: false, detail: 'a personal access token is required' });
  });
});

describe('App Store Connect', () => {
  it('signs a short-lived ES256 token that the matching public key verifies', () => {
    const at = 1_800_000_000;
    const [header, claims, signature] = mintAppStoreConnectToken(fields('appstoreconnect', apple) as any, at).split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', typ: 'JWT', kid: KEY_ID });
    expect(decode(claims)).toEqual({ iss: ISSUER, iat: at, exp: at + 600, aud: 'appstoreconnect-v1' });
    expect(decode(claims).exp - decode(claims).iat).toBeLessThanOrEqual(20 * 60);
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey(ec.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('checks the key by listing one app, with the token in the header and nowhere else', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: '1', attributes: { name: 'Fixture App' } }] }));
    await expect(checkDeveloperCredentials({ service: 'appstoreconnect', values: apple, fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual({ ok: true, accountLabel: `Key ${KEY_ID}`, detail: 'Connected.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.appstoreconnect.apple.com/v1/apps?limit=1');
    expect(init.redirect).toBe('error');
    const bearer = (init.headers as Record<string, string>).authorization;
    expect(bearer).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(decode(bearer.split('.')[1])).toMatchObject({ iss: ISSUER, aud: 'appstoreconnect-v1' });
  });

  it.each([
    [401, 'authentication', /rejected that key.*Issuer ID.*Key ID/],
    [403, 'authorization', /role is not allowed to read your apps/],
    [500, 'unknown', /answered 500/],
  ])('says plainly what a %i means and never quotes the key', async (status, category, message) => {
    const fetchImpl = vi.fn(async () => json({ errors: [{ code: 'NOT_AUTHORIZED', detail: 'provider words' }] }, status as number));
    const check = await checkDeveloperCredentials({ service: 'appstoreconnect', values: apple, fetchImpl: fetchImpl as typeof fetch });
    expect(check).toMatchObject({ ok: false, category, detail: expect.stringMatching(message) });
    expect(JSON.stringify(check)).not.toContain(bodyOf(P8).slice(0, 24));
    expect(JSON.stringify(check)).not.toContain(ISSUER);
  });

  it('reports an unreachable service as that, and an unreadable key without calling out', async () => {
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(checkDeveloperCredentials({ service: 'appstoreconnect', values: apple, fetchImpl: down as unknown as typeof fetch }))
      .resolves.toMatchObject({ ok: false, category: 'network' });
    const never = vi.fn();
    await expect(checkDeveloperCredentials({ service: 'appstoreconnect', values: { ...apple, privateKey: 'garbage' }, fetchImpl: never as unknown as typeof fetch }))
      .resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/could not be read/) });
    expect(never).not.toHaveBeenCalled();
  });

  it('lists apps, or one app\'s customer reviews, read-only', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: '123', attributes: { name: 'Fixture App', bundleId: 'com.example.app' } }] }))
      .mockResolvedValueOnce(json({ data: [{ id: 'r1', attributes: { rating: 4, title: 'Nice', body: 'Works  well', createdDate: '2026-01-02T03:04:05Z', territory: 'USA' } }] }));
    await expect(listDeveloperResourcesFor({ service: 'appstoreconnect', values: apple, fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual([{ id: '123', name: 'Fixture App', kind: 'app', detail: 'com.example.app' }]);
    await expect(listDeveloperResourcesFor({ service: 'appstoreconnect', values: apple, appId: '123', fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual([{ id: 'r1', name: 'Nice', kind: 'review', rating: 4, detail: 'Works well — 2026-01-02T03:04:05Z · USA' }]);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.appstoreconnect.apple.com/v1/apps?limit=25');
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://api.appstoreconnect.apple.com/v1/apps/123/customerReviews?limit=25&sort=-createdDate');
    expect(fetchImpl.mock.calls.every((c) => (c[1] as RequestInit).method === undefined)).toBe(true);
    // An app id is a number; anything else never reaches the URL.
    await expect(listDeveloperResourcesFor({ service: 'appstoreconnect', values: apple, appId: '../users', fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(/number/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Google Play', () => {
  const happy = () => vi.fn(async (url: string | URL | Request) => String(url).includes('oauth2.googleapis.com')
    ? json({ access_token: 'short-lived-access', expires_in: 3600 })
    : json({ reviews: [{ reviewId: 'g1', authorName: 'Ada', comments: [{ userComment: { text: 'Great app', starRating: 5, lastModified: { seconds: '1767322800' } } }] }] }));

  it('trades an RS256 assertion at Google\'s own endpoint, then reads the reviews of the package', async () => {
    const fetchImpl = happy();
    await expect(checkDeveloperCredentials({ service: 'googleplay', values: google, fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual({ ok: true, accountLabel: PACKAGE, detail: 'Connected.' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The fixed endpoint, not the one the pasted file named.
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(tokenInit.method).toBe('POST');
    const form = new URLSearchParams(String(tokenInit.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key-id' });
    expect(decode(claims)).toMatchObject({
      iss: 'josi-reader@fixture-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token',
    });
    expect(decode(claims).exp - decode(claims).iat).toBeLessThanOrEqual(3600);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), createPublicKey(rsa.privateKey), Buffer.from(signature, 'base64url'))).toBe(true);

    const [reviewsUrl, reviewsInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(reviewsUrl).toBe(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/reviews?maxResults=1`);
    expect((reviewsInit.headers as Record<string, string>).authorization).toBe('Bearer short-lived-access');
    expect(reviewsUrl).not.toContain('short-lived-access');
  });

  const refused = (reviews: Response, token: Response = json({ access_token: 'short-lived-access' })) =>
    vi.fn(async (url: string | URL | Request) => (String(url).includes('oauth2.googleapis.com') ? token : reviews));

  it.each([
    ['a key Google no longer accepts', () => refused(json({}), json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)), 'authentication', /private key does not match the account/, 1],
    ['a deleted service account', () => refused(json({}), json({ error: 'invalid_grant', error_description: 'Invalid grant: account not found' }, 400)), 'authentication', /does not recognise that service account/, 1],
    ['no access to that app', () => refused(json({ error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'permissionDenied' }] } }, 403)), 'authorization', /has no access to com\.example\.app/, 2],
    ['the API switched off', () => refused(json({ error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } }, 403)), 'authorization', /Android Developer API is not switched on/, 2],
    ['an unknown package', () => refused(json({ error: { code: 404 } }, 404)), 'authorization', /no app called com\.example\.app/, 2],
  ])('says plainly what %s means and never quotes the key', async (_name, make, category, message, calls) => {
    const fetchImpl = make();
    const check = await checkDeveloperCredentials({ service: 'googleplay', values: google, fetchImpl: fetchImpl as typeof fetch });
    expect(check).toMatchObject({ ok: false, category, detail: expect.stringMatching(message) });
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    const said = JSON.stringify(check);
    expect(said).not.toContain(bodyOf(RSA_PEM).slice(0, 24));
    expect(said).not.toContain('josi-reader@');
    expect(said).not.toContain('short-lived-access');
  });

  it('lists the connected app\'s reviews, read-only', async () => {
    const fetchImpl = happy();
    await expect(listDeveloperResourcesFor({ service: 'googleplay', values: google, fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toEqual([{ id: 'g1', name: 'Ada', kind: 'review', rating: 5, detail: `Great app — ${new Date(1767322800 * 1000).toISOString()}` }]);
    expect(String(fetchImpl.mock.calls[1][0])).toContain(`/applications/${PACKAGE}/reviews?maxResults=25`);
  });
});

describe('the single-token check is unchanged', () => {
  it('still verifies a pasted token through the fields entry point', async () => {
    const fetchImpl = vi.fn(async () => json({ login: 'octocat' }));
    await expect(checkDeveloperCredentials({ service: 'github', values: { token: 'fixture-token' }, fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toMatchObject({ ok: true, accountLabel: 'octocat' });
    expect((fetchImpl.mock.calls[0] as any)[1].headers.authorization).toBe('Bearer fixture-token');
  });

  it('will not treat a store as a token service', async () => {
    const never = vi.fn();
    await expect(checkDeveloperToken({ service: 'appstoreconnect', token: 'x', fetchImpl: never as unknown as typeof fetch })).resolves.toMatchObject({ ok: false });
    expect(never).not.toHaveBeenCalled();
  });
});
