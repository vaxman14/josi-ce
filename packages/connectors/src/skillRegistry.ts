// Where a skill package may come from, and how one is fetched.
//
// THE SOURCE TABLE IS THE TRUST LIST, and this is the whole of the "install
// only from somewhere trusted" rule. There is no function in this file — and no
// route anywhere above it — that takes a package body or a package URL. An
// install names a SOURCE ROW and a KEY inside that source's index; everything
// else about the request is built from the row. So "which registries may this
// installation install from?" is answered by a table an administrator can read,
// not by whatever was in the last request.
//
// Two kinds of source are fetched, and they are fetched identically:
//
//   registry    a curated registry an administrator chose to trust.
//   repository  one repository somebody supplied explicitly.
//
// They are distinguished because PROVENANCE IS SHOWN — "a registry we trust"
// and "a repository somebody pointed us at" are different sentences to read
// beside an installed skill — and never because one is checked less than the
// other. A third kind, `builtin`, is the catalogue compiled into this release
// and never touches the network at all.
//
// THE OUTBOUND RULES, which are the same rules 0035 and 0036 follow:
//
//   * HTTPS only. The digest that would catch a rewritten package travels in
//     the same document as the package.
//   * The host column IS the allowlist. Every URL is re-parsed before it is
//     requested and refused unless its host matches exactly.
//   * A package URL must lie UNDER the index URL. A registry that can point at
//     an arbitrary path on its own host is a registry that can point anywhere
//     its host can be made to serve — including an upload directory.
//   * Every resolved address is checked, not the first, and anything off the
//     public internet is refused.
//   * Redirects are never followed. Validating a URL and then chasing a 302
//     checks the wrong URL.
//   * Bodies are capped and read as JSON. Nothing here is executed, extracted
//     or written to disk.
//
// NO CREDENTIAL, ANYWHERE IN THIS FILE. A private registry needs a token, a
// token needs a store, a rotation story and an owner, and an installer holding
// one would be a second credential broker with none of those. CE fetches from
// registries that answer without one.
import { isIP } from 'node:net';
import { appendEvent, type Db } from '@josi-ce/core';
import { ConnectorError, type ErrorCategory } from './providers.js';
import { nonPublicReason } from './devServiceProbe.js';
import { MAX_SKILL_PACKAGE_BYTES } from './skillPackage.js';
import { BUILTIN_SKILL_CATALOGUE, builtinSkillDocument } from './starterSkills.js';

// ------------------------------------------------------------------- shapes

export type SkillSourceKind = 'builtin' | 'registry' | 'repository';

export interface SkillSourceRow {
  id: string;
  kind: SkillSourceKind;
  name: string;
  index_url: string | null;
  host: string | null;
  public_key: string | null;
  enabled: boolean;
  last_index_at: string | null;
  last_index_ok: boolean | null;
  last_error_category: ErrorCategory | null;
  created_at: string;
  updated_at: string;
}

/** One line of a source's index: enough to show somebody what is on offer, and
 * the digest that pins what they will get if they install it. NOT the package —
 * an index entry carries no instructions, so browsing a catalogue never puts a
 * stranger's prose anywhere. */
export interface SkillCatalogueEntry {
  key: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  /** What the index says the package will ask for. Advisory: the package's own
   * list is what gets stored, and a package whose capabilities differ from its
   * index entry has a different digest and is refused anyway. */
  capabilities: string[];
  /** The pinned canonical digest. Required: an index entry without one cannot
   * pin anything, and "install whatever is at that address right now" is not an
   * integrity check. */
  digest: string;
  /** Absolute, already checked against the source's host and the index's
   * directory. Null for the built-in catalogue, which has no address. */
  packageUrl: string | null;
}

export class SkillInputError extends Error {}
export class SkillFetchError extends ConnectorError {}

/** How many sources one installation may add.
 *
 * A ceiling rather than a setting, for the reason `MAX_MCP_SERVERS_PER_USER`
 * gives: the number that matters is "more than anybody has a reason for", and
 * an operator asked to choose it has been handed a question they cannot
 * answer. */
export const MAX_SKILL_SOURCES = 10;

const MAX_INDEX_BYTES = 256 * 1024;
const MAX_CATALOGUE_ENTRIES = 200;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface SkillFetchOptions {
  /** Injected by the tests so no suite contacts a registry. Unset in
   * production, where the real fetch is used. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

// --------------------------------------------------------------- validation

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

export function validateSkillSourceName(raw: unknown): string {
  const name = text(raw);
  if (!name) throw new SkillInputError('give this source a name you will recognise later');
  if (name.length > 80) throw new SkillInputError('a name can be at most 80 characters');
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new SkillInputError('a name cannot contain control characters or line breaks');
  }
  return name;
}

/** `builtin` is deliberately not accepted from a request. It is seeded by
 * migration 0037 and there is exactly one of it; a route that could create
 * another would be a route that could claim something ships with Josi. */
export function validateSkillSourceKind(raw: unknown): 'registry' | 'repository' {
  const value = text(raw);
  if (value === 'registry' || value === 'repository') return value;
  throw new SkillInputError(
    'say whether this is a curated registry or one repository you are pointing Josi at',
  );
}

export interface ValidatedSkillIndexUrl {
  indexUrl: string;
  host: string;
}

/**
 * The index document's address, and the host allowlist derived from it.
 *
 * A query string is refused here, unlike the MCP endpoint and like the custom
 * API base URL, and the difference is real: every package URL is resolved
 * against this one, so an index carrying a query would produce package
 * addresses that either silently lose it or inherit it into a path nobody
 * reviewed. A fragment is refused for the reason it always is — it never
 * travels, so accepting one would mean storing an address that is not the one
 * used.
 */
export function validateSkillIndexUrl(raw: unknown): ValidatedSkillIndexUrl {
  const value = text(raw);
  if (!value) throw new SkillInputError('give the index address, starting with https://');
  if (value.length > 500) throw new SkillInputError('that address is too long');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SkillInputError('that is not a valid web address');
  }
  if (url.protocol !== 'https:') {
    throw new SkillInputError(
      'the address must start with https://. A package fetched over plain http is a package any '
      + 'network in between may rewrite, and the digest that would catch that travels in the same '
      + 'document.',
    );
  }
  if (url.username || url.password) {
    throw new SkillInputError('Josi does not send a credential to a skill registry, so do not put one in the address');
  }
  if (url.search) {
    throw new SkillInputError('the index address cannot carry a query string');
  }
  if (url.hash) {
    throw new SkillInputError('the address cannot carry a #fragment — a fragment is never sent');
  }
  if (url.pathname.includes('..')) throw new SkillInputError('the address cannot contain ".."');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.includes('/')) throw new SkillInputError('that address has no host in it');
  if (!/\/[^/]+$/.test(url.pathname)) {
    throw new SkillInputError(
      'point at the index document itself, for example https://example.com/skills/index.json — not '
      + 'at a directory. Package addresses are resolved against it.',
    );
  }
  return { indexUrl: url.toString(), host };
}

/** A source's ed25519 signing key, raw and base64.
 *
 * Optional, and what it changes is stated plainly rather than left implicit: a
 * source WITH a key means every package from it must be signed and verify
 * against it, and a source without one means signatures cannot be checked and
 * every skill from it says so on screen. */
export function validateSkillPublicKey(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new SkillInputError(
      'a signing key must be a raw 32-byte ed25519 public key in base64 — 44 characters ending in "="',
    );
  }
  if (Buffer.from(value, 'base64').length !== 32) {
    throw new SkillInputError('that is not a 32-byte ed25519 public key');
  }
  return value;
}

// ------------------------------------------------------------------ storage

const UUID = /^[0-9a-fA-F-]{36}$/;

export async function listSkillSources(db: Db): Promise<SkillSourceRow[]> {
  // The built-in catalogue first, then by name. It is what somebody looking for
  // "what can I install?" should see before a registry they added last month.
  return db.query<SkillSourceRow>(
    `select * from skill_sources order by (kind = 'builtin') desc, name`,
  );
}

export async function skillSourceById(db: Db, id: string): Promise<SkillSourceRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<SkillSourceRow>(`select * from skill_sources where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function builtinSkillSource(db: Db): Promise<SkillSourceRow | null> {
  const rows = await db.query<SkillSourceRow>(`select * from skill_sources where kind = 'builtin'`);
  return rows[0] ?? null;
}

export async function createSkillSource(
  db: Db,
  args: {
    actorUserId: string;
    kind: 'registry' | 'repository';
    name: string;
    indexUrl: string;
    host: string;
    publicKey: string | null;
  },
): Promise<SkillSourceRow> {
  const rows = await db.query<SkillSourceRow>(
    `insert into skill_sources (kind, name, index_url, host, public_key)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [args.kind, args.name, args.indexUrl, args.host, args.publicKey],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.source_added',
    subjectType: 'skill_source',
    subjectId: rows[0].id,
    // The host and whether it publishes a key. A public key is not a secret and
    // the host is an outbound destination from the operator's own machine, so
    // both belong in the trail that says where this installation may install
    // from.
    payload: { sourceKind: args.kind, host: args.host, signed: !!args.publicKey },
  });
  return rows[0];
}

export async function setSkillSourceEnabled(
  db: Db,
  args: { actorUserId: string; source: SkillSourceRow; enabled: boolean },
): Promise<SkillSourceRow> {
  const rows = await db.query<SkillSourceRow>(
    `update skill_sources set enabled = $2 where id = $1 returning *`,
    [args.source.id, args.enabled],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: args.enabled ? 'skill.source_enabled' : 'skill.source_disabled',
    subjectType: 'skill_source',
    subjectId: args.source.id,
    payload: { sourceKind: args.source.kind, host: args.source.host },
  });
  return rows[0];
}

export async function deleteSkillSource(
  db: Db,
  args: { actorUserId: string; source: SkillSourceRow },
): Promise<void> {
  // `skills.source_id` is `on delete restrict`, so a source that installed
  // something cannot be removed out from under it. The route turns the
  // resulting refusal into a sentence naming what to remove first.
  await db.query(`delete from skill_sources where id = $1`, [args.source.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'skill.source_removed',
    subjectType: 'skill_source',
    subjectId: args.source.id,
    payload: { sourceKind: args.source.kind, host: args.source.host },
  });
}

export async function recordSkillIndexCheck(
  db: Db,
  args: { sourceId: string; ok: boolean; category?: ErrorCategory | null },
): Promise<void> {
  await db.query(
    `update skill_sources set last_index_at = now(), last_index_ok = $2, last_error_category = $3
      where id = $1`,
    [args.sourceId, args.ok, args.ok ? null : (args.category ?? 'provider_error')],
  );
}

// ---------------------------------------------------------------- the fetch

async function defaultResolve(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Resolves a host and refuses anything that is not on the public internet.
 *
 * A fourth copy of this shape, alongside `devServiceProbe`, `customApiRequest`
 * and `mcpClient`, and deliberately not a shared wrapper: what differs between
 * them is the SENTENCE, each written for the person who has to fix that
 * particular thing. `nonPublicReason` — the part that would be dangerous to get
 * wrong twice — is imported rather than copied.
 */
export async function assertPublicSkillHost(
  host: string,
  opts: SkillFetchOptions = {},
): Promise<string[]> {
  // An address that is already a literal never reaches a resolver, so it would
  // sail past a check that only inspects DNS answers.
  if (isIP(host)) {
    const reason = nonPublicReason(host);
    if (reason) {
      throw new SkillFetchError(
        `${host} is ${reason}, and Josi only fetches skills from the public internet.`,
        { category: 'network' },
      );
    }
    return [host];
  }

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    throw new SkillFetchError(`${host} could not be looked up from this server`, { category: 'network' });
  }
  if (!addresses.length) {
    throw new SkillFetchError(`${host} resolved to no addresses from this server`, { category: 'network' });
  }
  // EVERY address, not the first: a hostname answering with one public and one
  // metadata address is an attack, not a lucky draw.
  for (const address of addresses) {
    const reason = nonPublicReason(address);
    if (reason) {
      throw new SkillFetchError(
        `${host} resolved to ${reason} on this server, so Josi refused the request. A skill `
        + 'registry must be reachable on the public internet.',
        { category: 'network' },
      );
    }
  }
  return addresses;
}

function categoryForStatus(status: number): ErrorCategory {
  if (status === 401) return 'revoked';
  if (status === 403) return 'insufficient_scope';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

async function readCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new SkillFetchError(
        'that registry answered with more data than Josi will read from one. Nothing was stored.',
        { category: 'provider_error' },
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * One GET to one address on the source's pinned host, parsed as JSON.
 *
 * The only outbound request this feature makes. Everything about it is fixed
 * here rather than passed in: the method, the headers, the refusal to follow a
 * redirect, the cap, and the fact that no credential is attached.
 */
async function getJson(
  source: SkillSourceRow,
  url: string,
  limit: number,
  opts: SkillFetchOptions,
): Promise<unknown> {
  // Re-parsed here as well as by the caller. This function is the one that
  // makes the request, so "the caller already checked" would be a property of
  // one call path rather than of this function.
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || hostname !== source.host) {
    throw new SkillFetchError(
      `that address would leave ${source.name}, so Josi refused to fetch it`,
      { category: 'provider_error' },
    );
  }
  await assertPublicSkillHost(hostname, opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        // Named so an operator reading their own registry's access log can see
        // which software asked. Carries no version of anything sensitive.
        'user-agent': 'josi-ce',
      },
      // Validating a URL and then chasing a 302 checks the wrong URL.
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    // Deliberately not `err.message`: a fetch error can carry the request URL,
    // and interpolating one is how an address ends up somewhere it should not.
    throw new SkillFetchError(`Josi could not reach ${source.name}`, { category: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new SkillFetchError(
      `${source.name} answered with a redirect, which Josi does not follow. If that registry has `
      + 'moved, change its address here.',
      { category: 'provider_error' },
    );
  }
  if (!res.ok) {
    throw new SkillFetchError(
      `${source.name} answered ${res.status}. Nothing was installed.`,
      { category: categoryForStatus(res.status) },
    );
  }

  const body = await readCapped(res, limit);
  try {
    return JSON.parse(body);
  } catch {
    throw new SkillFetchError(
      `${source.name} did not answer with JSON, so Josi could not read a catalogue from it.`,
      { category: 'provider_error' },
    );
  }
}

// -------------------------------------------------------------- the catalogue

/**
 * A package address, resolved against the index and then checked twice.
 *
 * The containment rule is the one that matters. A registry naming
 * `/uploads/anything.json` on its own host would be a registry that can point
 * Josi at whatever that host can be made to serve; requiring the package to lie
 * under the index's own directory means the operator of the index is vouching
 * for the address as well as for the entry.
 */
function packageUrlFor(source: SkillSourceRow, indexUrl: string, path: unknown): string {
  const value = text(path);
  if (!value) throw new SkillFetchError('an index entry named no package address', { category: 'provider_error' });
  let resolved: URL;
  try {
    resolved = new URL(value, indexUrl);
  } catch {
    throw new SkillFetchError('an index entry named an address Josi could not read', { category: 'provider_error' });
  }
  const host = resolved.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (resolved.protocol !== 'https:' || host !== source.host) {
    throw new SkillFetchError(
      `${source.name} pointed at another host, so Josi refused it. A registry may only serve `
      + 'packages from its own address.',
      { category: 'provider_error' },
    );
  }
  const directory = new URL(indexUrl).pathname.replace(/[^/]*$/, '');
  if (!resolved.pathname.startsWith(directory) || resolved.pathname.includes('..')) {
    throw new SkillFetchError(
      `${source.name} pointed outside its own catalogue directory, so Josi refused it.`,
      { category: 'provider_error' },
    );
  }
  return resolved.toString();
}

const DIGEST = /^[0-9a-f]{64}$/;

/** One index document, read into catalogue entries or refused.
 *
 * Every entry must pin a digest. An index that names a package without one is
 * an index that cannot promise what will arrive, and "install whatever is at
 * that address right now" is not an integrity check. */
export function readSkillIndex(source: SkillSourceRow, indexUrl: string, raw: unknown): SkillCatalogueEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillFetchError(`${source.name} did not answer with a catalogue`, { category: 'provider_error' });
  }
  const doc = raw as Record<string, unknown>;
  if (doc.formatVersion !== 1) {
    throw new SkillFetchError(
      `${source.name} publishes a catalogue format this version of Josi does not read.`,
      { category: 'provider_error' },
    );
  }
  const list = Array.isArray(doc.skills) ? doc.skills : null;
  if (!list) {
    throw new SkillFetchError(`${source.name} listed no skills`, { category: 'provider_error' });
  }
  if (list.length > MAX_CATALOGUE_ENTRIES) {
    throw new SkillFetchError(
      `${source.name} listed more than ${MAX_CATALOGUE_ENTRIES} skills, which Josi will not read in one go.`,
      { category: 'provider_error' },
    );
  }

  const entries: SkillCatalogueEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = text(row.key).toLowerCase();
    const version = text(row.version);
    const digest = text(row.digest).toLowerCase();
    // A malformed entry is SKIPPED rather than failing the whole catalogue: one
    // bad row in a registry of forty should not stop somebody installing the
    // other thirty-nine, and nothing can be installed from a row that was
    // skipped anyway.
    if (!/^[a-z][a-z0-9_]{0,38}[a-z0-9]$/.test(key)) continue;
    if (!/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(version)) continue;
    if (!DIGEST.test(digest)) continue;
    if (entries.some((e) => e.key === key)) continue;

    let packageUrl: string;
    try {
      packageUrl = packageUrlFor(source, indexUrl, row.path);
    } catch {
      continue;
    }

    entries.push({
      key,
      // The registry's own words, capped and stripped of control characters
      // before they reach a screen. They are pinned by nothing at this stage,
      // which is exactly why the package's own fields — not these — are what
      // gets stored on install.
      name: clean(row.name, 80) || key,
      version,
      publisher: clean(row.publisher, 80) || source.name,
      summary: clean(row.summary, 300),
      capabilities: Array.isArray(row.capabilities)
        ? row.capabilities.filter((c): c is string => typeof c === 'string').slice(0, 20).map((c) => clean(c, 60))
        : [],
      digest,
      packageUrl,
    });
  }
  return entries;
}

function clean(raw: unknown, max: number): string {
  return text(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim();
}

/**
 * What a source is offering right now.
 *
 * The built-in catalogue answers from the source tree and contacts nothing. A
 * registry or a repository is fetched, and the outcome is recorded on the row
 * either way so "this registry has not answered since Tuesday" is a state the
 * page can show rather than an error somebody saw once.
 */
export async function skillCatalogue(
  db: Db,
  source: SkillSourceRow,
  opts: SkillFetchOptions = {},
): Promise<SkillCatalogueEntry[]> {
  if (source.kind === 'builtin') return BUILTIN_SKILL_CATALOGUE.map((entry) => ({ ...entry }));
  if (!source.index_url || !source.host) {
    throw new SkillFetchError(`${source.name} has no address`, { category: 'provider_error' });
  }
  try {
    const raw = await getJson(source, source.index_url, MAX_INDEX_BYTES, opts);
    const entries = readSkillIndex(source, source.index_url, raw);
    await recordSkillIndexCheck(db, { sourceId: source.id, ok: true });
    return entries;
  } catch (err) {
    const category = err instanceof ConnectorError ? err.category : 'provider_error';
    await recordSkillIndexCheck(db, { sourceId: source.id, ok: false, category });
    throw err;
  }
}

/**
 * The package document for one catalogue entry, as the source served it.
 *
 * Returned raw and UNVALIDATED. Reading it is `readSkillPackage`'s job and the
 * separation is deliberate: the thing that fetches bytes should not also be the
 * thing that decides whether they are trustworthy, or the two get tested as
 * one.
 */
export async function fetchSkillPackage(
  source: SkillSourceRow,
  entry: SkillCatalogueEntry,
  opts: SkillFetchOptions = {},
): Promise<unknown> {
  if (source.kind === 'builtin') return builtinSkillDocument(entry.key);
  if (!entry.packageUrl) {
    throw new SkillFetchError(`${source.name} named no address for that skill`, { category: 'provider_error' });
  }
  return getJson(source, entry.packageUrl, MAX_SKILL_PACKAGE_BYTES, opts);
}
