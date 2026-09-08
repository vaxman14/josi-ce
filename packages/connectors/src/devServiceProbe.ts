// Asking GitHub, Netlify, Vercel or Supabase whether a token is any good.
//
// This is the only file that sends a developer-service credential anywhere, so
// it is the only place the outbound rules have to hold — and they are stated as
// code rather than as a convention:
//
//   * ONE HOST PER SERVICE, pinned in `SERVICES[...].apiHost`. Nothing in the
//     connect form is a URL, a host, a port or a path, so there is nothing for
//     a person or a bug to point somewhere else. The path is built here from a
//     literal, and `devServiceUrl` refuses anything that is not a simple
//     absolute path.
//   * ADDRESSES ARE CHECKED AT REQUEST TIME, not once at save time. A hostname
//     that resolves to something benign when validated and to 169.254.169.254
//     when used is the whole DNS-rebinding trick, and these four hostnames are
//     resolved by whatever resolver the host is configured with.
//   * PUBLIC ADDRESSES ONLY. This is the opposite of packages/llm/src/ssrf.ts
//     and deliberately so: that module must permit loopback and LAN addresses,
//     because self-hosted inference is the point of it. Here, all four services
//     are public SaaS. api.github.com resolving to 127.0.0.1 or to a LAN box is
//     never correct and is refused, which is why the check below is written out
//     rather than imported — the policies differ, and one function that took a
//     "strict" flag would eventually be called with the wrong one.
//   * REDIRECTS ARE NOT FOLLOWED. Validating a URL and then letting the client
//     chase a 302 checks the wrong thing.
//   * NOTHING FROM A PROVIDER'S BODY REACHES A LOG OR A RESPONSE. Failures
//     become an `ErrorCategory` and a sentence CE wrote. GitHub and Supabase
//     both echo the offending request in some error bodies, and a request to
//     these APIs carries an Authorization header.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SERVICES, type DevService } from './devServices.js';
import { ConnectorError, type ErrorCategory } from './providers.js';

/** A refusal from this layer. Carries a category the UI already knows how to
 * say in plain language, and a message CE wrote. */
export class DevServiceError extends ConnectorError {}

export interface DevFetchOptions {
  /** Injected by the tests, so no suite contacts GitHub, Netlify, Vercel or
   * Supabase. Unset in production. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, so no suite performs DNS. Unset in production. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

/** A provider that has not answered in fifteen seconds is a provider the person
 * is waiting on with a spinner. Long enough for a cold API, short enough that
 * the page says something. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The most of a provider response we will read. These endpoints return a small
 * JSON object or a short list; anything larger is either a different endpoint
 * or something trying to make us hold it in memory. */
const MAX_BODY_BYTES = 512 * 1024;

// ------------------------------------------------------------------ addresses

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

/** Everything that is not the public internet.
 *
 * Loopback and the RFC1918 ranges are here alongside link-local and metadata,
 * which is the difference from the model-endpoint checker: for these four,
 * anything off the public internet means DNS is answering with something these
 * hostnames should never resolve to. */
const NON_PUBLIC_V4 = [
  { base: '0.0.0.0', bits: 8, why: 'the unspecified address' },
  { base: '10.0.0.0', bits: 8, why: 'a private network address' },
  { base: '100.64.0.0', bits: 10, why: 'a carrier-grade NAT address' },
  { base: '127.0.0.0', bits: 8, why: 'a loopback address' },
  { base: '169.254.0.0', bits: 16, why: 'a link-local or cloud-metadata address' },
  { base: '172.16.0.0', bits: 12, why: 'a private network address' },
  { base: '192.0.0.0', bits: 24, why: 'a reserved address' },
  { base: '192.168.0.0', bits: 16, why: 'a private network address' },
  { base: '198.18.0.0', bits: 15, why: 'a benchmarking address' },
  { base: '224.0.0.0', bits: 4, why: 'a multicast address' },
  { base: '240.0.0.0', bits: 4, why: 'a reserved address' },
] as const;

/** The IPv4 address inside a v4-mapped IPv6 literal, in EITHER spelling.
 *
 * `::ffff:169.254.169.254` is what people write and `::ffff:a9fe:a9fe` is what
 * `new URL()` and some resolvers produce. A checker that understands only the
 * dotted form understands neither — the same lesson recorded in
 * packages/llm/src/ssrf.ts, applied here rather than rediscovered. */
function embeddedV4(address: string): string | null {
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return dotted[1];
  if (address === '::1') return null;
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** Why this address is not somewhere a public API lives, or null when it is
 * fine. Exported so the test can attack it directly rather than only through a
 * request. */
export function nonPublicReason(address: string): string | null {
  const family = isIP(address);

  if (family === 4) {
    const value = v4ToInt(address);
    if (value === null) return 'not a usable address';
    for (const { base, bits, why } of NON_PUBLIC_V4) {
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      const baseValue = v4ToInt(base);
      if (baseValue !== null && (value & mask) === (baseValue & mask)) return why;
    }
    return null;
  }

  if (family === 6) {
    const normalised = address.toLowerCase().replace(/^\[|\]$/g, '');
    const embedded = embeddedV4(normalised);
    if (embedded) return nonPublicReason(embedded);
    if (normalised === '::' || normalised === '::1') return 'a loopback address';
    if (normalised.startsWith('fe80')) return 'a link-local address';
    if (normalised.startsWith('ff')) return 'a multicast address';
    // fc00::/7 — unique local.
    if (/^f[cd]/.test(normalised)) return 'a private network address';
    return null;
  }

  return 'not an address';
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

// -------------------------------------------------------------------- request

/** Builds the one URL this service is allowed to be asked.
 *
 * The path is a literal from this file in every call. It is still checked,
 * because "it is always a literal today" is a property that stops being true
 * quietly. */
export function devServiceUrl(service: DevService, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) {
    throw new DevServiceError('that is not a path this service can be asked for', { category: 'provider_error' });
  }
  const url = new URL(`https://${SERVICES[service].apiHost}${path}`);
  if (url.hostname !== SERVICES[service].apiHost || url.protocol !== 'https:') {
    throw new DevServiceError('that request would leave the service it belongs to', { category: 'provider_error' });
  }
  return url.toString();
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DevServiceError('that provider sent more than Josi will read', { category: 'provider_error' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export interface DevResponse {
  status: number;
  headers: Headers;
  /** Parsed when the provider sent JSON; null otherwise. Never logged. */
  body: unknown;
}

/**
 * One request to one pinned host, with the token in an Authorization header.
 *
 * The token is passed as an argument and used once. It is never put in the URL
 * (URLs reach logs, proxies and error messages), never in a query string, and
 * never returned.
 */
export async function devServiceFetch(
  service: DevService,
  path: string,
  args: { token: string; accept?: string },
  opts: DevFetchOptions = {},
): Promise<DevResponse> {
  const spec = SERVICES[service];
  const url = devServiceUrl(service, path);

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(spec.apiHost);
  } catch {
    throw new DevServiceError(`${spec.label} could not be looked up from this server`, { category: 'network' });
  }
  if (!addresses.length) {
    throw new DevServiceError(`${spec.label} resolved to no addresses from this server`, { category: 'network' });
  }
  // EVERY address, not the first: a hostname answering with one public and one
  // metadata address is an attack, not a lucky draw.
  for (const address of addresses) {
    const reason = nonPublicReason(address);
    if (reason) {
      throw new DevServiceError(
        `${spec.apiHost} resolved to ${reason} on this server, so Josi refused the request. `
        + 'Check this host\'s DNS.',
        { category: 'network' },
      );
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${args.token}`,
        accept: args.accept ?? 'application/json',
        // Named so an operator reading their own provider's audit log can see
        // which software called. Carries no version of anything sensitive.
        'user-agent': 'josi-ce',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    // Deliberately not `err.message`: an undici error can carry the request
    // URL, and the URL is fine, but the habit of interpolating fetch errors is
    // how a header ends up in a log.
    throw new DevServiceError(`Josi could not reach ${spec.label}`, { category: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new DevServiceError(
      `${spec.label} answered with a redirect, which Josi does not follow`,
      { category: 'provider_error' },
    );
  }

  const text = await readCapped(res).catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

// -------------------------------------------------------------------- mapping

/** What an HTTP status from one of these four means to the person who has to
 * fix it. Never the provider's own words. */
export function categoryForStatus(status: number, headers?: Headers): ErrorCategory {
  if (status === 401) return 'revoked';
  if (status === 403) {
    // GitHub returns 403 for both "your token may not do that" and "you have
    // used your hour's requests". They are different problems with different
    // fixes, and the remaining-requests header is what tells them apart.
    if (headers?.get('x-ratelimit-remaining') === '0') return 'rate_limited';
    return 'insufficient_scope';
  }
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

function sentenceFor(service: DevService, category: ErrorCategory): string {
  const spec = SERVICES[service];
  switch (category) {
    case 'revoked':
      return `${spec.label} did not accept that token. It may have been revoked, mistyped, or have expired.`;
    case 'insufficient_scope':
      return `${spec.label} accepted the token but refused this request, which usually means the token `
        + 'was not given the permissions listed above.';
    case 'rate_limited':
      return `${spec.label} is asking Josi to slow down. Try again shortly; nothing is wrong with the token.`;
    case 'network':
      return `Josi could not reach ${spec.label}.`;
    case 'expired':
      return `That ${spec.label} token has expired. Create a new one and paste it in.`;
    default:
      return `${spec.label} returned an error. If it keeps happening, create a new token.`;
  }
}

// --------------------------------------------------------------------- probes

export interface ProbeResult {
  accountLabel: string | null;
  accountId: string | null;
  /** What the provider says the token covers, when it says anything. Null means
   * "this provider does not report scopes" — the UI must not render that as an
   * empty list, because an empty list reads as "no access". */
  reportedScopes: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const idOf = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Asks the service who this token belongs to.
 *
 * A read-only identity call, chosen per service to be the least the provider
 * offers: nothing here lists a repository's contents, reads an environment
 * variable, or touches a deployment. Success is what makes a connection
 * storable; a failure is returned as a category and never stored as a working
 * connection.
 */
export async function probeDevService(
  service: DevService,
  args: { token: string; projectRef?: string | null },
  opts: DevFetchOptions = {},
): Promise<ProbeResult> {
  switch (service) {
    case 'github': {
      const res = await devServiceFetch(service, '/user', {
        token: args.token, accept: 'application/vnd.github+json',
      }, opts);
      if (res.status !== 200) {
        const category = categoryForStatus(res.status, res.headers);
        throw new DevServiceError(sentenceFor(service, category), { category, status: res.status });
      }
      const body = res.body as { login?: unknown; id?: unknown } | null;
      return {
        accountLabel: str(body?.login),
        accountId: idOf(body?.id),
        // Classic tokens carry this header; fine-grained ones send it empty or
        // not at all, and an empty string is stored as null so the UI can say
        // "this token does not report scopes" rather than "no scopes".
        reportedScopes: str(res.headers.get('x-oauth-scopes')),
      };
    }

    case 'netlify': {
      const res = await devServiceFetch(service, '/api/v1/user', { token: args.token }, opts);
      if (res.status !== 200) {
        const category = categoryForStatus(res.status, res.headers);
        throw new DevServiceError(sentenceFor(service, category), { category, status: res.status });
      }
      const body = res.body as { slug?: unknown; full_name?: unknown; id?: unknown } | null;
      // `slug` is the account's own handle. The email address Netlify also
      // returns is deliberately not stored: it identifies the person rather
      // than the account, and nothing here needs it.
      return { accountLabel: str(body?.slug) ?? str(body?.full_name), accountId: idOf(body?.id), reportedScopes: null };
    }

    case 'vercel': {
      const res = await devServiceFetch(service, '/v2/user', { token: args.token }, opts);
      if (res.status !== 200) {
        const category = categoryForStatus(res.status, res.headers);
        throw new DevServiceError(sentenceFor(service, category), { category, status: res.status });
      }
      const body = res.body as { user?: { username?: unknown; id?: unknown } } | null;
      return {
        accountLabel: str(body?.user?.username),
        accountId: idOf(body?.user?.id),
        reportedScopes: null,
      };
    }

    case 'supabase': {
      const res = await devServiceFetch(service, '/v1/projects', { token: args.token }, opts);
      if (res.status !== 200) {
        const category = categoryForStatus(res.status, res.headers);
        throw new DevServiceError(sentenceFor(service, category), { category, status: res.status });
      }
      const projects = Array.isArray(res.body)
        ? (res.body as Array<{ id?: unknown; ref?: unknown; name?: unknown }>)
        : [];
      if (args.projectRef) {
        const match = projects.find((p) => str(p.ref) === args.projectRef || str(p.id) === args.projectRef);
        if (!match) {
          // The token works; it just does not reach the project the person
          // named. Saying so is more useful than a generic failure, and it is
          // not a leak: they supplied the reference.
          throw new DevServiceError(
            'That token works, but it cannot see a project with that reference. Check the reference, '
            + 'or use a token from the account that owns the project.',
            { category: 'insufficient_scope', status: res.status },
          );
        }
        return { accountLabel: str(match.name), accountId: args.projectRef, reportedScopes: null };
      }
      return {
        accountLabel: `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`,
        accountId: null,
        reportedScopes: null,
      };
    }
  }
}
