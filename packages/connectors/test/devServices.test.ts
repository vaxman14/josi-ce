// Developer services, at the unit boundary.
//
// Everything here is the part that has no HTTP session around it: what a token
// field will accept, what the sealed row contains, and — the half that matters
// most — where a request for one of these four services is allowed to go.
//
// No suite in this file performs DNS or contacts a provider. Both are injected.
import { describe, expect, it } from 'vitest';
import { MasterKey, looksSealed, openSealed, seal } from '@josi-ce/core';
import {
  DevServiceError, SERVICES, TOKEN_MASK, DevServiceInputError,
  categoryForStatus, devServiceFetch, devServiceUrl, looksLikeSupabaseProjectKey, nonPublicReason,
  probeDevService, validateProjectRef, validateToken,
  type DevServiceSecret,
} from '../src/index.js';

/** Public addresses, so the pinned-host check passes and the test is about
 * whatever it is actually about. */
const publicResolve = async () => ['140.82.121.6'];

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

describe('what the token field accepts', () => {
  it('refuses an empty or missing value', () => {
    expect(() => validateToken('github', '')).toThrow(DevServiceInputError);
    expect(() => validateToken('github', '   ')).toThrow(DevServiceInputError);
    expect(() => validateToken('github', undefined)).toThrow(DevServiceInputError);
    expect(() => validateToken('github', 12345)).toThrow(DevServiceInputError);
  });

  it('refuses a paste that brought whitespace or a line break with it', () => {
    expect(() => validateToken('github', 'abc def')).toThrow(/space/);
    expect(() => validateToken('netlify', 'abc\ndef')).toThrow(/space|line break/);
    expect(() => validateToken('vercel', `abc${String.fromCharCode(0)}def`)).toThrow(DevServiceInputError);
  });

  it('refuses something far too long to be a token', () => {
    expect(() => validateToken('vercel', 'x'.repeat(5000))).toThrow(/too long/);
  });

  it('trims and accepts an ordinary token', () => {
    expect(validateToken('github', '  fixture-github-token  ')).toBe('fixture-github-token');
  });

  // The one refusal that is about least privilege rather than shape. A
  // service_role key bypasses every row-level security policy on a Supabase
  // project, and pasting it here instead of a personal access token is the most
  // damaging mistake this page allows.
  it('refuses a Supabase project API key where a personal access token belongs', () => {
    const jwtShaped = 'eyJhbGciOiJI.eyJyb2xlIjo.sig';
    expect(looksLikeSupabaseProjectKey(jwtShaped)).toBe(true);
    expect(() => validateToken('supabase', jwtShaped)).toThrow(/service_role|project API key/);
    // The same string is not a JWT-shaped value for the other three, and this
    // check must not spread to them: a GitHub token that happens to start with
    // those letters is still a GitHub token.
    expect(() => validateToken('github', jwtShaped)).not.toThrow();
  });

  it('does not require a provider prefix, because provider formats change', () => {
    // A validator that gets ahead of a provider refuses a credential that
    // works. The guided setup says what the prefix looks like; the server does
    // not make it a rule.
    expect(validateToken('supabase', 'sbp-fixture-value')).toBe('sbp-fixture-value');
    expect(validateToken('netlify', 'abcdef0123456789')).toBe('abcdef0123456789');
  });
});

describe('the Supabase project reference', () => {
  it('accepts exactly twenty lowercase letters', () => {
    expect(validateProjectRef('abcdefghijklmnopqrst')).toBe('abcdefghijklmnopqrst');
  });

  it('treats absent as absent rather than as an error', () => {
    expect(validateProjectRef(undefined)).toBeNull();
    expect(validateProjectRef('')).toBeNull();
    expect(validateProjectRef('  ')).toBeNull();
  });

  it('refuses anything that could be a URL, a host or a path', () => {
    for (const bad of [
      'https://evil.test',
      '../../admin',
      'abcdefghijklmnopqrst/../other',
      'ABCDEFGHIJKLMNOPQRST',
      'short',
    ]) {
      expect(() => validateProjectRef(bad), bad).toThrow(DevServiceInputError);
    }
  });
});

describe('what is stored is ciphertext', () => {
  const key = new MasterKey(Buffer.alloc(32, 11));

  it('seals the token and opens it again', () => {
    const sealed = seal(key, { token: 'fixture-developer-token' } satisfies DevServiceSecret);
    expect(looksSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('fixture-developer-token');
    expect(openSealed<DevServiceSecret>(key, sealed).token).toBe('fixture-developer-token');
  });

  it('the mask carries no part of the credential', () => {
    // Not the last four characters and not the length: a mask derived from the
    // secret is still made of the secret.
    expect(TOKEN_MASK).toMatch(/^[^A-Za-z0-9]+$/);
    expect(TOKEN_MASK.length).toBeGreaterThan(4);
  });
});

describe('where a developer-service request may go', () => {
  it('refuses to leave the pinned host', () => {
    expect(devServiceUrl('github', '/user')).toBe('https://api.github.com/user');
    for (const bad of ['user', '//evil.test/user', '/../../evil', '/a/../../b']) {
      expect(() => devServiceUrl('github', bad), bad).toThrow(DevServiceError);
    }
  });

  it('pins one host per service and never a host somebody typed', () => {
    expect(SERVICES.github.apiHost).toBe('api.github.com');
    expect(SERVICES.netlify.apiHost).toBe('api.netlify.com');
    expect(SERVICES.vercel.apiHost).toBe('api.vercel.com');
    expect(SERVICES.supabase.apiHost).toBe('api.supabase.com');
  });

  // The cloud-metadata endpoint is the one that turns a DNS mistake into a
  // compromised cloud account.
  it('refuses an address that is not on the public internet', () => {
    for (const address of [
      '169.254.169.254', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9',
      '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1',
      // The v4-mapped spellings. `::ffff:a9fe:a9fe` is the same address as
      // `::ffff:169.254.169.254`, and a checker that knows only one knows
      // neither.
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
    ]) {
      expect(nonPublicReason(address), address).toBeTruthy();
    }
    expect(nonPublicReason('140.82.121.6')).toBeNull();
    expect(nonPublicReason('2606:50c0:8000::153')).toBeNull();
  });

  it('refuses the request when the hostname resolves somewhere it should not', async () => {
    // DNS rebinding, or a poisoned resolver on the host. The hostname is one of
    // ours and cannot be changed by anybody; the ANSWER is the attack.
    await expect(devServiceFetch('github', '/user', { token: 't' }, {
      resolve: async () => ['169.254.169.254'],
      fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch,
    })).rejects.toThrow(/link-local|cloud-metadata/);
  });

  it('refuses when only one of several answers is hostile', async () => {
    await expect(devServiceFetch('github', '/user', { token: 't' }, {
      resolve: async () => ['140.82.121.6', '127.0.0.1'],
      fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch,
    })).rejects.toThrow(DevServiceError);
  });

  it('does not follow a redirect', async () => {
    await expect(devServiceFetch('netlify', '/api/v1/user', { token: 't' }, {
      resolve: publicResolve,
      fetchImpl: (async () => new Response('', {
        status: 302, headers: { location: 'https://evil.test/' },
      })) as unknown as typeof fetch,
    })).rejects.toThrow(/redirect/);
  });

  it('puts the token in a header and never in the URL', async () => {
    let seenUrl = '';
    let auth: string | null = null;
    await devServiceFetch('github', '/user', { token: 'fixture-github-token' }, {
      resolve: publicResolve,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(url);
        auth = new Headers(init?.headers).get('authorization');
        return ok({ login: 'someone' });
      }) as unknown as typeof fetch,
    });
    expect(seenUrl).toBe('https://api.github.com/user');
    expect(seenUrl).not.toContain('fixture-github-token');
    expect(auth).toBe('Bearer fixture-github-token');
  });
});

describe('what a provider status means', () => {
  it('separates "not permitted" from "slow down"', () => {
    expect(categoryForStatus(401)).toBe('revoked');
    expect(categoryForStatus(403)).toBe('insufficient_scope');
    expect(categoryForStatus(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe('rate_limited');
    expect(categoryForStatus(429)).toBe('rate_limited');
    expect(categoryForStatus(500)).toBe('provider_error');
  });
});

describe('the identity probe, per service', () => {
  const probeWith = (impl: typeof fetch) => ({ resolve: publicResolve, fetchImpl: impl });

  it('reads a GitHub account and the scopes a classic token reports', async () => {
    const result = await probeDevService('github', { token: 't' }, probeWith(
      (async () => ok({ login: 'octocat', id: 583231 }, { 'x-oauth-scopes': 'repo, read:user' })) as unknown as typeof fetch,
    ));
    expect(result).toEqual({ accountLabel: 'octocat', accountId: '583231', reportedScopes: 'repo, read:user' });
  });

  it('reports null scopes for a fine-grained GitHub token rather than an empty list', async () => {
    // An empty list on screen reads as "no access". Null lets the page say
    // "this token does not report its permissions", which is what is true.
    const result = await probeDevService('github', { token: 't' }, probeWith(
      (async () => ok({ login: 'octocat', id: 1 }, { 'x-oauth-scopes': '' })) as unknown as typeof fetch,
    ));
    expect(result.reportedScopes).toBeNull();
  });

  it('reads a Netlify account without keeping the email address', async () => {
    const result = await probeDevService('netlify', { token: 't' }, probeWith(
      (async () => ok({ id: 'nl-1', slug: 'team-slug', email: 'someone@example.test' })) as unknown as typeof fetch,
    ));
    expect(result.accountLabel).toBe('team-slug');
    expect(JSON.stringify(result)).not.toContain('example.test');
  });

  it('reads a Vercel account', async () => {
    const result = await probeDevService('vercel', { token: 't' }, probeWith(
      (async () => ok({ user: { id: 'v-1', username: 'someone' } })) as unknown as typeof fetch,
    ));
    expect(result.accountLabel).toBe('someone');
  });

  it('counts Supabase projects when no reference was given', async () => {
    const result = await probeDevService('supabase', { token: 't' }, probeWith(
      (async () => ok([{ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'One' }])) as unknown as typeof fetch,
    ));
    expect(result.accountLabel).toBe('1 project');
  });

  it('names the Supabase project when the reference matches', async () => {
    const result = await probeDevService('supabase', { token: 't', projectRef: 'aaaaaaaaaaaaaaaaaaaa' }, probeWith(
      (async () => ok([{ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'One' }])) as unknown as typeof fetch,
    ));
    expect(result.accountLabel).toBe('One');
  });

  it('says so when the token cannot reach the project that was named', async () => {
    await expect(probeDevService('supabase', { token: 't', projectRef: 'bbbbbbbbbbbbbbbbbbbb' }, probeWith(
      (async () => ok([{ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'One' }])) as unknown as typeof fetch,
    ))).rejects.toThrow(/cannot see a project/);
  });

  it('turns a refusal into a category and never repeats the provider body', async () => {
    const secretish = 'PROVIDER-BODY-QUOTING-THE-TOKEN';
    const err = await probeDevService('github', { token: 't' }, probeWith(
      (async () => new Response(JSON.stringify({ message: secretish }), { status: 401 })) as unknown as typeof fetch,
    )).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevServiceError);
    expect((err as DevServiceError).category).toBe('revoked');
    expect((err as DevServiceError).message).not.toContain(secretish);
  });

  it('turns an unreachable provider into a network category', async () => {
    const err = await probeDevService('vercel', { token: 't' }, probeWith(
      (async () => { throw new Error('connect ECONNREFUSED 1.2.3.4:443'); }) as unknown as typeof fetch,
    )).catch((e: unknown) => e);
    expect((err as DevServiceError).category).toBe('network');
    expect((err as DevServiceError).message).not.toContain('ECONNREFUSED');
  });
});

describe('the guided setup says what the token needs', () => {
  it('names minimum permissions for every service', () => {
    for (const spec of Object.values(SERVICES)) {
      expect(spec.minimumPermissions.length, spec.key).toBeGreaterThan(0);
      expect(spec.steps.length, spec.key).toBeGreaterThan(2);
      expect(spec.revokeHint.length, spec.key).toBeGreaterThan(10);
    }
  });

  it('admits it where a provider cannot scope a token at all', () => {
    // Least privilege is advice for these three, not something CE can request.
    // Saying otherwise would be a promise the product cannot keep.
    expect(SERVICES.netlify.scopeCaveat).toMatch(/cannot be scoped|does not offer/i);
    expect(SERVICES.vercel.scopeCaveat).toBeTruthy();
    expect(SERVICES.supabase.scopeCaveat).toMatch(/account-wide/i);
    // GitHub genuinely does offer a narrow token, so it makes no such excuse.
    expect(SERVICES.github.scopeCaveat).toBeNull();
  });
});
