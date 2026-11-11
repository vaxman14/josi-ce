import { MasterKey, setVaultLock } from '@josi-ce/core';
import { saveDeveloperConnection } from '@josi-ce/connectors';
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { developerIntegrationToolAvailability, executeDeveloperIntegrationTool, executeDeveloperResourceTool } from '../src/developerIntegrationTools.js';
import { TOOL_SPECS_BY_NAME } from '../src/tools.js';

let db:TestDb;let owner:string;let other:string;
beforeEach(async()=>{db=await testDb();owner=(await createUser(db,{email:'native-owner@test.invalid',username:'nativeowner',role:'member'})).id;other=(await createUser(db,{email:'native-other@test.invalid',username:'nativeother',role:'member'})).id;await db.query(`insert into developer_connections(owner_user_id,service,credentials_enc,account_label,status,last_check_at,last_check_ok) values($1,'gitlab','sealed-never-return','git-user','active',now(),true),($2,'notion','other-secret','other workspace','active',now(),true)`,[owner,other]);});

describe('native integration assistant status',()=>{
  it('is offered only to an owner with a connection and is registered read-only',async()=>{
    expect(await developerIntegrationToolAvailability(db,owner)).toHaveLength(2);
    expect(TOOL_SPECS_BY_NAME.get('list_native_integrations')?.actionClass).toBeNull();
    expect(TOOL_SPECS_BY_NAME.get('list_native_resources')?.actionClass).toBeNull();
  });
  it('returns provider identity and capability without credentials or another user',async()=>{
    const result=await executeDeveloperIntegrationTool(db,owner);
    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0]).toMatchObject({provider:'gitlab',account:'git-user',healthy:true});
    expect(JSON.stringify(result)).not.toContain('sealed-never-return');
    expect(JSON.stringify(result)).not.toContain('other workspace');
  });
});


const key = new MasterKey(Buffer.alloc(32, 72));
describe('native resource credential dispatch', () => {
  beforeEach(async () => {
    await testVault(db, key);
    await db.query("update developer_service_policy set mode='everyone' where service='github'");
    await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'github', credentials: { token: 'synthetic-token' }, accountLabel: 'Fixture' });
  });
  it('does not call the provider or poison health when the Vault box is locked', async () => {
    await setVaultLock(db, { ownerUserId: owner, locked: true, actorUserId: owner });
    let calls = 0;
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'github' }, { masterKey: () => key, fetchImpl: async () => { calls++; return new Response('[]'); } });
    expect(result.ok).toBe(false); expect(calls).toBe(0);
    expect((await db.query("select last_check_ok from developer_connections where owner_user_id=$1 and service='github'", [owner]))[0].last_check_ok).toBe(true);
  });
  it('discards results when the connection rotates during discovery', async () => {
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'github' }, { masterKey: () => key, fetchImpl: async () => {
      await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'github', credentials: { token: 'replacement-token' }, accountLabel: 'Replacement' });
      return new Response(JSON.stringify([{ id: 1, full_name: 'fixture/repo' }]));
    } });
    expect(result.ok).toBe(false);
    expect((await db.query("select account_label,last_used_at from developer_connections where owner_user_id=$1 and service='github'", [owner]))[0]).toEqual({ account_label: 'Replacement', last_used_at: null });
  });
  it('keeps a transient discovery outage from disabling an otherwise active connection', async () => {
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'github' }, { masterKey: () => key, fetchImpl: async () => { throw new Error('synthetic outage'); } });
    expect(result.ok).toBe(false);
    expect((await db.query("select status,last_check_ok from developer_connections where owner_user_id=$1 and service='github'", [owner]))[0]).toEqual({ status: 'active', last_check_ok: false });
  });
});


describe('store reads mint their token from the sealed key at call time', () => {
  const p8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const serviceAccount = JSON.stringify({ type: 'service_account', private_key: rsa, client_email: 'reader@fixture.iam.gserviceaccount.com' });
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  beforeEach(async () => {
    await testVault(db, key);
    await db.query("update developer_service_policy set mode='everyone' where service in ('appstoreconnect','googleplay')");
    await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'appstoreconnect', accountLabel: 'Key FIXTUREKEY',
      credentials: { issuerId: '57246542-96fe-1a63-e053-0824d011072a', keyId: 'FIXTUREKEY', privateKey: p8 } });
    await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'googleplay', accountLabel: 'com.example.app',
      credentials: { serviceAccountJson: serviceAccount, packageName: 'com.example.app' } });
  });

  it('lists App Store Connect apps, then one app\'s customer reviews, without returning the key or the token', async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), authorization: (init.headers as Record<string, string>).authorization });
      return String(url).includes('customerReviews')
        ? reply({ data: [{ id: 'r1', attributes: { rating: 2, title: 'Crashes', body: 'It closes on launch', createdDate: '2026-01-02T03:04:05Z', territory: 'DEU' } }] })
        : reply({ data: [{ id: '123', attributes: { name: 'Fixture App', bundleId: 'com.example.app' } }] });
    }) as unknown as typeof fetch;
    const apps = await executeDeveloperResourceTool(db, owner, { provider: 'appstoreconnect' }, { masterKey: () => key, fetchImpl });
    expect(apps).toEqual({ ok: true, provider: 'appstoreconnect', resources: [{ id: '123', name: 'Fixture App', kind: 'app', detail: 'com.example.app' }] });
    const reviews = await executeDeveloperResourceTool(db, owner, { provider: 'appstoreconnect', app_id: '123' }, { masterKey: () => key, fetchImpl });
    expect(reviews).toMatchObject({ ok: true, resources: [{ id: 'r1', name: 'Crashes', kind: 'review', rating: 2 }] });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.appstoreconnect.apple.com/v1/apps?limit=25',
      'https://api.appstoreconnect.apple.com/v1/apps/123/customerReviews?limit=25&sort=-createdDate',
    ]);
    for (const c of calls) expect(c.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const said = JSON.stringify([apps, reviews]);
    expect(said).not.toContain('PRIVATE KEY');
    expect(said).not.toContain(calls[0].authorization.slice(7));
    expect((await db.query("select last_used_at from developer_connections where owner_user_id=$1 and service='appstoreconnect'", [owner]))[0].last_used_at).not.toBeNull();
  });

  it('lists Google Play reviews after exchanging the service account, without returning either', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return String(url).includes('oauth2.googleapis.com')
        ? reply({ access_token: 'short-lived-access' })
        : reply({ reviews: [{ reviewId: 'g1', authorName: 'Ada', comments: [{ userComment: { text: 'Great app', starRating: 5 } }] }] });
    }) as unknown as typeof fetch;
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'googleplay' }, { masterKey: () => key, fetchImpl });
    expect(result).toEqual({ ok: true, provider: 'googleplay', resources: [{ id: 'g1', name: 'Ada', kind: 'review', rating: 5, detail: 'Great app' }] });
    expect(urls).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/reviews?maxResults=25',
    ]);
    const said = JSON.stringify(result);
    for (const secret of ['PRIVATE KEY', 'short-lived-access', 'reader@fixture']) expect(said).not.toContain(secret);
  });

  it('reports a refused store read without the provider\'s words and without disabling the connection', async () => {
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'googleplay' }, { masterKey: () => key,
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'secret provider detail' }), { status: 400 })) as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, provider: 'googleplay' });
    expect(JSON.stringify(result)).not.toContain('secret provider detail');
    expect((await db.query("select status from developer_connections where owner_user_id=$1 and service='googleplay'", [owner]))[0].status).toBe('active');
  });

  it('does not let another member read through my store connection', async () => {
    let calls = 0;
    const result = await executeDeveloperResourceTool(db, other, { provider: 'appstoreconnect' }, { masterKey: () => key, fetchImpl: (async () => { calls++; return reply({}); }) as unknown as typeof fetch });
    expect(result.ok).toBe(false); expect(calls).toBe(0);
  });
});
