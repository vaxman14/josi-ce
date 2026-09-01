// LB11 — identity, licensing, and the page that loaded forever.
//
// Three separate defects share this file because they share a cause: a claim
// was made in one place and never checked anywhere.
//
//   * The shepherd identity was retired, and half the repository still said so.
//   * The licence text claimed branding "may not be removed or replaced", which
//     purports to restrict what the AGPL grants and inverts what trademark law
//     actually asks of a fork.
//   * The Workspace page swallowed every error and rendered "Loading…" forever.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../../web/src/lib/api.js';
import { classifyResource } from '../../web/src/lib/useResource.js';

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('LB11.1 — the shepherd is retired', () => {
  /** Every tracked file that still mentions it, with its context. */
  function shepherdHits(): Array<{ file: string; line: number; text: string }> {
    const out = execFileSync(
      'git',
      [
        'grep', '-n', '-i', 'shepherd', '--', '.',
        // The brief that raised the blocker, preserved verbatim.
        ':!LAUNCH_BLOCKER_FIX_PROMPT.txt',
        // This file. A test that forbids a word has to be able to write it,
        // and exempting itself is the only alternative to never running.
        ':!apps/api/test/branding.test.ts',
        // The closure record, which explains what was retired and why.
        ':!LAUNCH_AUDIT.md',
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    if (!out) return [];
    return out.split('\n').map((row) => {
      const [file, line, ...rest] = row.split(':');
      return { file, line: Number(line), text: rest.join(':') };
    });
  }

  it('appears in no product surface', () => {
    // The UI, the licence files, the README, the installer, the docs site and
    // the compose files are what a user or an operator actually sees.
    const productSurfaces = /^(apps\/|packages\/|docs-site\/|scripts\/|README\.md|NOTICE|TRADEMARK\.md|LICENSE|docker-compose|\.env)/;
    const offenders = shepherdHits().filter((h) => productSurfaces.test(h.file));
    expect(
      offenders,
      `live shepherd reference(s): ${offenders.map((o) => `${o.file}:${o.line}`).join(', ')}`,
    ).toEqual([]);
  });

  it('survives only inside a labelled historical record', () => {
    // The phase evidence documents record runs that really happened and are not
    // rewritten. Each surviving mention must sit in a file that says so.
    for (const hit of shepherdHits()) {
      const src = read(hit.file);
      expect(
        /Historical record|Superseded at launch|historical/i.test(src),
        `${hit.file}:${hit.line} mentions the shepherd but is not labelled as a historical record`,
      ).toBe(true);
    }
  });

  it('ships no shepherd artwork', () => {
    // The retired mark was 772155 bytes. The derived J is an order of magnitude
    // smaller, but the check that matters is the pinned hash below, not the size.
    for (const asset of ['apps/web/public/brand/josi-mark.png', 'docs-site/brand/josi-mark.png']) {
      const bytes = readFileSync(join(root, asset));
      expect(bytes.length, `${asset} is the retired shepherd`).not.toBe(772155);
      expect(bytes.subarray(0, 8).toString('hex'), asset).toBe('89504e470d0a1a0a');
    }
  });
});

describe('LB11.2 — the J identity is applied everywhere', () => {
  it('derives the mark from the approved wordmark rather than a second master', () => {
    const script = read('scripts/build-brand.sh');
    expect(script).toMatch(/josi-wordmark\.png/);
    expect(script).toMatch(/apps\/web\/public\/brand\/josi-mark\.png/);
    expect(script).toMatch(/icon-192\.png/);
    expect(script).toMatch(/icon-512\.png/);
    expect(script).toMatch(/icon-maskable-512\.png/);
    expect(script).toMatch(/docs-site\/brand\/josi-mark\.png/);
  });

  it('pins the wordmark, which is the one thing never regenerated', () => {
    const harness = read('scripts/test-web-runtime.sh');
    expect(harness).toMatch(/6778fd3584f6ed4d9ed7281752aa09276fd7a871d3e3cfbe2e3a607c509c9e45/);
  });

  it('declares every PWA icon the manifest promises, at the size it promises', () => {
    const manifest = JSON.parse(read('apps/web/public/manifest.webmanifest')) as {
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const bytes = readFileSync(join(root, 'apps/web/public', icon.src));
      expect(bytes.subarray(0, 8).toString('hex'), icon.src).toBe('89504e470d0a1a0a');
      // PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      const [declaredW, declaredH] = icon.sizes.split('x').map(Number);
      expect(width, `${icon.src} width`).toBe(declaredW);
      expect(height, `${icon.src} height`).toBe(declaredH);
    }
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('points the favicon and the docs site at the mark', () => {
    expect(read('apps/web/index.html')).toMatch(/rel="icon"[^>]*\/brand\/josi-mark\.png/);
    expect(read('docs-site/template.html')).toMatch(/brand\/josi-mark\.png/);
  });
});

describe('LB11.3 — copyright and trademark are stated as separate rights', () => {
  const trademark = read('TRADEMARK.md');
  const notice = read('NOTICE');
  const readme = read('README.md');

  /** Markdown wraps, so a phrase check has to ignore where the lines broke. */
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it('no longer claims the branding may not be removed', () => {
    // Sentences, not lines: the claim was wrapped across two of them, and a
    // line-based check both missed it and flagged the paragraph withdrawing it.
    for (const [name, src] of [['TRADEMARK.md', trademark], ['NOTICE', notice], ['README.md', readme]] as const) {
      const claims = flat(src)
        .split(/(?<=\.)\s+/)
        .filter((s) => /may not be (removed|replaced)|not replaceable|branding is (a )?required/i.test(s))
        // Withdrawing a claim means naming it, so the withdrawal is allowed to.
        .filter((s) => !/was wrong|withdrawn|earlier version|previous|Historical/i.test(s));
      expect(claims, `${name} still requires branding: ${claims.join(' | ')}`).toEqual([]);
    }
  });

  it('says plainly that a fork may remove the branding', () => {
    expect(flat(trademark)).toMatch(/remove our branding from your fork/i);
    expect(flat(readme)).toMatch(/you may remove its branding/i);
  });

  it('keeps the enforceable restriction — do not pass a fork off as ours', () => {
    expect(trademark).toMatch(/do not present a modified version as the official Josi product/i);
    expect(trademark).toMatch(/nominative use/i);
  });

  it('is still marked as a draft needing a lawyer, and says it is not advice', () => {
    expect(trademark).toMatch(/DRAFT — REQUIRES LEGAL REVIEW/);
    expect(trademark).toMatch(/nothing in it is legal advice/i);
    expect(trademark.match(/\[REVIEW\]/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(notice).toMatch(/DRAFT AND HAS NOT BEEN REVIEWED BY A LAWYER/);
  });

  it('flags the withdrawal itself as the question for counsel', () => {
    // It is a substantive weakening of the previous position, and burying that
    // is how a business discovers it after publishing.
    expect(trademark).toMatch(/most important question in this file/i);
  });
});

describe('LB11.5 — the workspace page cannot load forever', () => {
  const ok = { kind: 'loaded' as const, data: { workspace: { name: 'x' } }, empty: false };

  it('renders loaded data', () => {
    expect(classifyResource(ok).state).toBe('ready');
  });

  it('distinguishes an honest empty from a failure', () => {
    expect(classifyResource({ ...ok, empty: true }).state).toBe('empty');
  });

  it('reports a server failure, and offers a retry', () => {
    const verdict = classifyResource({ kind: 'failed', error: new ApiError(500, 'the database is unavailable') });
    expect(verdict.state).toBe('error');
    expect(verdict.message).toBe('the database is unavailable');
    expect(verdict.retryable).toBe(true);
  });

  it('reports a timeout as a timeout, not as a load that is still going', () => {
    const verdict = classifyResource({ kind: 'timedOut', afterMs: 15_000 });
    expect(verdict.state).toBe('timeout');
    expect(verdict.message).toMatch(/did not answer within 15 seconds/);
    expect(verdict.retryable).toBe(true);
  });

  it('sends an expired session to sign in rather than offering a pointless retry', () => {
    for (const status of [401, 403]) {
      const verdict = classifyResource({ kind: 'failed', error: new ApiError(status, 'nope') });
      expect(verdict.state, String(status)).toBe('unauthorized');
      expect(verdict.retryable, String(status)).toBe(false);
      expect(verdict.message.length).toBeGreaterThan(0);
    }
  });

  it('says something for a failure that is not an ApiError at all', () => {
    // A dropped connection rejects with a TypeError from fetch, not an
    // ApiError. That is the case the original `.catch(() => undefined)` turned
    // into a permanent spinner.
    const verdict = classifyResource({ kind: 'failed', error: new TypeError('Failed to fetch') });
    expect(verdict.state).toBe('error');
    expect(verdict.message).toBe('Failed to fetch');
    expect(verdict.retryable).toBe(true);
  });

  it('has no outcome that leaves the page loading', () => {
    const outcomes = [
      ok,
      { ...ok, empty: true },
      { kind: 'failed' as const, error: new ApiError(500, 'x') },
      { kind: 'failed' as const, error: new ApiError(401, 'x') },
      { kind: 'failed' as const, error: new ApiError(403, 'x') },
      { kind: 'failed' as const, error: new TypeError('x') },
      { kind: 'failed' as const, error: 'a string nobody expected' },
      { kind: 'timedOut' as const, afterMs: 1000 },
    ];
    for (const outcome of outcomes) {
      expect(classifyResource(outcome).state, JSON.stringify(outcome.kind)).not.toBe('loading');
    }
  });

  it('is what the page actually uses', () => {
    // A tested helper the screen does not call proves nothing about the screen.
    const page = read('apps/web/src/pages/admin/Workspace.tsx');
    expect(page).toMatch(/useResource/);
    expect(page).not.toMatch(/\.catch\(\(\) => undefined\)/);
    for (const state of ['empty', 'unauthorized', 'error', 'timeout', 'ready']) {
      expect(page, `Workspace.tsx renders nothing for "${state}"`).toContain(state);
    }
    expect(page, 'a failure must offer a way out').toMatch(/Try again/);
  });
});
