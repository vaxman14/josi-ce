// App Store Connect and Google Play.
//
// Neither store hands out a token a person can paste. Each hands out a signing
// key, and every request is authorised by a short-lived token minted from it:
//
//   * App Store Connect: an ES256 JWT signed with the team's .p8 key, naming
//     the Key ID and the Issuer ID. It is the bearer token itself.
//   * Google Play: an RS256 JWT signed with the service account's key, traded
//     at Google's token endpoint for an access token.
//
// So the sealed payload is the key, and the token exists only for the length
// of one call. Nothing here stores, logs or returns either of them, and no
// message built here quotes anything the person pasted except the two values
// that are not secret and that they need to see to fix a mistake: the Key ID
// and the package name.
//
// Hosts are fixed in source. A service account file names its own `token_uri`;
// it is ignored on purpose, because honouring it would let a pasted file point
// this server at any address it liked.
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { DeveloperCheck, DeveloperResource } from './developerServices.js';

export type DeveloperStoreService = 'appstoreconnect' | 'googleplay';
export const DEVELOPER_STORE_SERVICES: readonly DeveloperStoreService[] = ['appstoreconnect', 'googleplay'];
export function isDeveloperStoreService(value: unknown): value is DeveloperStoreService {
  return value === 'appstoreconnect' || value === 'googleplay';
}

export interface AppStoreConnectKey { issuerId: string; keyId: string; privateKey: string }
/** `packageName` is optional and may list several, separated by commas. The
 * service account is the credential; it reaches every app it was invited to. */
export interface GooglePlayKey { serviceAccountJson: string; packageName: string }

export type StoreFieldResult<T> = { ok: true; values: T } | { ok: false; detail: string };

const APPLE_API = 'https://api.appstoreconnect.apple.com';
const APPLE_AUDIENCE = 'appstoreconnect-v1';
/** Apple refuses anything over twenty minutes. Ten is plenty for one call. */
const APPLE_TOKEN_SECONDS = 600;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting';
/** The one Google call that lists the apps an account can see. */
const GOOGLE_PLAY_APPS = 'https://playdeveloperreporting.googleapis.com/v1beta1/apps:search?pageSize=25';
const GOOGLE_PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const GOOGLE_ASSERTION_SECONDS = 600;
const MAX_KEY_CHARS = 20_000;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const clip = (value: unknown, max: number): string => text(value).replace(/\s+/g, ' ').trim().slice(0, max);
const oneLine = (value: unknown, max: number): string => text(value).replace(/\r\n?/g, '\n').trim().slice(0, max);

/** A pasted PEM, put back into the shape the parser needs.
 *
 * Keys arrive with Windows line endings, with the line breaks turned into the
 * two characters `\n` (copied out of a JSON file), or flattened onto one line
 * by a text field. All three are the same key. Returns '' when what is left is
 * not base64 at all. */
export function normalizePem(input: string): string {
  const cleaned = input.replace(/\r\n?/g, '\n').replace(/\\r/g, '').replace(/\\n/g, '\n').trim();
  const framed = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(cleaned);
  const label = framed ? framed[1] : 'PRIVATE KEY';
  const body = (framed ? framed[2] : cleaned).replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+=*$/.test(body)) return '';
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

function readKey(pem: string): KeyObject | null {
  if (!pem) return null;
  try { return createPrivateKey({ key: pem, format: 'pem' }); } catch { return null; }
}

// ------------------------------------------------------------ normalisation

export function normalizeAppStoreConnectFields(body: Record<string, unknown>): StoreFieldResult<AppStoreConnectKey> {
  const issuerId = oneLine(body.issuerId, 80).toLowerCase();
  const keyId = oneLine(body.keyId, 40).toUpperCase();
  const rawKey = text(body.privateKey);
  if (!issuerId) return { ok: false, detail: 'An Issuer ID is required.' };
  if (!keyId) return { ok: false, detail: 'A Key ID is required.' };
  if (!rawKey.trim()) return { ok: false, detail: 'The .p8 private key is required.' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(issuerId)) {
    return { ok: false, detail: 'That Issuer ID is not the right shape. It is the long identifier with dashes shown above the keys in App Store Connect → Users and Access → Integrations.' };
  }
  if (!/^[A-Z0-9]{6,20}$/.test(keyId)) {
    return { ok: false, detail: 'That Key ID is not the right shape. It is the short code of letters and digits listed beside the key.' };
  }
  if (rawKey.length > MAX_KEY_CHARS) return { ok: false, detail: 'That private key is too long to be a .p8 file.' };
  const privateKey = normalizePem(rawKey);
  const key = readKey(privateKey);
  if (!key) {
    return { ok: false, detail: 'That private key could not be read. Paste the whole .p8 file, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines.' };
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { ok: false, detail: 'That is a private key, but not an App Store Connect API key. Use the .p8 file downloaded from App Store Connect.' };
  }
  return { ok: true, values: { issuerId, keyId, privateKey } };
}

interface ServiceAccount { type: string; project_id?: string; private_key_id?: string; private_key: string; client_email: string }

function readServiceAccount(json: string): { account: ServiceAccount; key: KeyObject } | string {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch {
    return 'That is not valid JSON. Paste the whole service account key file exactly as Google gave it to you.';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'That is not a service account key. Paste the whole JSON key file from Google Cloud.';
  }
  if (parsed.type !== 'service_account') {
    return 'That JSON is not a service account key. In Google Cloud open the service account, add a key of type JSON, and paste that file.';
  }
  const email = oneLine(parsed.client_email, 320);
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !text(parsed.private_key).trim()) {
    return 'That service account key is incomplete: it has no account email or no private key. Download a new JSON key and paste the whole file.';
  }
  const pem = normalizePem(text(parsed.private_key));
  const key = readKey(pem);
  if (!key || key.asymmetricKeyType !== 'rsa') {
    return 'The private key inside that service account file could not be read. Download a new JSON key and paste the whole file.';
  }
  return {
    key,
    account: {
      type: 'service_account',
      ...(typeof parsed.project_id === 'string' ? { project_id: parsed.project_id.slice(0, 200) } : {}),
      ...(typeof parsed.private_key_id === 'string' ? { private_key_id: parsed.private_key_id.slice(0, 200) } : {}),
      private_key: pem,
      client_email: email,
    },
  };
}

const isPackageName = (value: string): boolean =>
  value.length <= 150 && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
export const googlePlayPackages = (packageName: string | undefined): string[] => (packageName ?? '').split(',').filter(Boolean);

export function normalizeGooglePlayFields(body: Record<string, unknown>): StoreFieldResult<GooglePlayKey> {
  const rawJson = text(body.serviceAccountJson).replace(/\r\n?/g, '\n').trim();
  // Optional, and may name several: the key belongs to the account, not to one app.
  const packages = [...new Set(text(body.packageName).split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean))];
  if (!rawJson) return { ok: false, detail: 'The service account JSON is required.' };
  if (rawJson.length > MAX_KEY_CHARS) return { ok: false, detail: 'That is too long to be a service account key file.' };
  if (packages.length > 50) return { ok: false, detail: 'List at most 50 package names.' };
  if (packages.some((p) => !isPackageName(p))) {
    return { ok: false, detail: 'That package name is not the right shape. It looks like com.example.app, exactly as shown in Google Play Console.' };
  }
  const packageName = packages.join(',');
  const read = readServiceAccount(rawJson);
  if (typeof read === 'string') return { ok: false, detail: read };
  // Only what signing needs is kept. The file's own endpoints are dropped
  // because they are never used.
  return { ok: true, values: { serviceAccountJson: JSON.stringify(read.account), packageName } };
}

// ------------------------------------------------------------------ signing

const b64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

function signJwt(alg: 'ES256' | 'RS256', header: Record<string, string>, claims: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64url(JSON.stringify({ alg, typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`;
  const signature = cryptoSign('sha256', Buffer.from(input, 'utf8'),
    // JWT wants the raw r||s pair, not the DER structure OpenSSL emits by default.
    alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${input}.${signature.toString('base64url')}`;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The bearer token for one App Store Connect call. Never stored. */
export function mintAppStoreConnectToken(key: AppStoreConnectKey, at: number = nowSeconds()): string {
  const privateKey = readKey(key.privateKey);
  if (!privateKey) throw new Error('The App Store Connect key is unreadable.');
  return signJwt('ES256', { kid: key.keyId }, { iss: key.issuerId, iat: at, exp: at + APPLE_TOKEN_SECONDS, aud: APPLE_AUDIENCE }, privateKey);
}

interface StoreCallOptions { fetchImpl?: typeof fetch; timeoutMs?: number }

function boundedFetch(opts: StoreCallOptions): typeof fetch {
  return (url, init) => (opts.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
}

type GoogleToken = { ok: true; accessToken: string } | { ok: false; check: DeveloperCheck };

/** Trade the service account key for a short-lived access token. */
async function exchangeGoogleToken(serviceAccountJson: string, opts: StoreCallOptions): Promise<GoogleToken> {
  const read = readServiceAccount(serviceAccountJson);
  if (typeof read === 'string') return { ok: false, check: { ok: false, category: 'authentication', detail: read } };
  const at = nowSeconds();
  const assertion = signJwt('RS256', read.account.private_key_id ? { kid: read.account.private_key_id } : {},
    { iss: read.account.client_email, scope: GOOGLE_PLAY_SCOPE, aud: GOOGLE_TOKEN_URL, iat: at, exp: at + GOOGLE_ASSERTION_SECONDS }, read.key);
  const response = await boundedFetch(opts)(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'josi-ce' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const body: any = await response.json().catch(() => null);
  if (response.status === 400 || response.status === 401) {
    // Google's own description is deliberately not passed on: it is written for
    // a developer reading a log, and this message is read by whoever pasted the
    // file.
    const reason = `${text(body?.error)} ${text(body?.error_description)}`.toLowerCase();
    const detail = /signature/.test(reason)
      ? 'Google rejected that service account key: the private key does not match the account. The key may have been deleted. Create a new JSON key and paste the whole file.'
      : /not found|disabled|deleted|invalid_client/.test(reason)
        ? 'Google does not recognise that service account. It may have been deleted or disabled. Check it in Google Cloud, then create a new JSON key.'
        : 'Google rejected that service account key. Create a new JSON key for the service account and paste the whole file.';
    return { ok: false, check: { ok: false, category: 'authentication', detail } };
  }
  if (!response.ok) return { ok: false, check: { ok: false, category: 'unknown', detail: `Google answered ${response.status} when the key was presented.` } };
  const accessToken = text(body?.access_token);
  if (!accessToken) return { ok: false, check: { ok: false, category: 'unknown', detail: 'Google accepted the key but did not return an access token.' } };
  return { ok: true, accessToken };
}

// ------------------------------------------------------------------- checks

/** Ask App Store Connect whether this key works, by listing one app. */
export async function checkAppStoreConnectKey(values: Record<string, string | undefined>, opts: StoreCallOptions = {}): Promise<DeveloperCheck> {
  const normal = normalizeAppStoreConnectFields(values);
  if (!normal.ok) return { ok: false, category: 'authentication', detail: normal.detail };
  try {
    const response = await boundedFetch(opts)(`${APPLE_API}/v1/apps?limit=1`, {
      headers: { authorization: `Bearer ${mintAppStoreConnectToken(normal.values)}`, accept: 'application/json', 'user-agent': 'josi-ce' },
    });
    if (response.status === 401) {
      return { ok: false, category: 'authentication',
        detail: 'App Store Connect rejected that key. Check that the Issuer ID and the Key ID are the ones shown beside this .p8 file, and that the key has not been revoked.' };
    }
    if (response.status === 403) {
      return { ok: false, category: 'authorization',
        detail: 'That key is valid, but its role is not allowed to read your apps. Check the key’s access in App Store Connect → Users and Access → Integrations.' };
    }
    if (response.status === 429) return { ok: false, category: 'unknown', detail: 'App Store Connect is limiting requests right now. Try again in a minute.' };
    if (!response.ok) return { ok: false, category: 'unknown', detail: `App Store Connect answered ${response.status}.` };
    const body: any = await response.json().catch(() => null);
    if (!Array.isArray(body?.data)) return { ok: false, category: 'unknown', detail: 'App Store Connect did not confirm the key.' };
    return { ok: true, accountLabel: `Key ${normal.values.keyId}`, detail: 'Connected.' };
  } catch {
    return { ok: false, category: 'network', detail: 'App Store Connect could not be reached from this server.' };
  }
}

function googleApiDisabled(body: any): boolean {
  const reasons = [
    ...(Array.isArray(body?.error?.errors) ? body.error.errors.map((e: any) => text(e?.reason)) : []),
    ...(Array.isArray(body?.error?.details) ? body.error.details.map((d: any) => text(d?.reason)) : []),
  ];
  return reasons.some((r) => r === 'accessNotConfigured' || r === 'SERVICE_DISABLED');
}

function googlePlayRefusal(status: number, body: any, packageName: string): DeveloperCheck | null {
  if (status === 401) {
    return { ok: false, category: 'authentication', detail: 'Google Play rejected the service account. Create a new JSON key and paste the whole file.' };
  }
  if (status === 403) {
    return googleApiDisabled(body)
      ? { ok: false, category: 'authorization',
        detail: 'The Google Play Android Developer API is not switched on for this service account’s Google Cloud project. Enable it there, then try again.' }
      : { ok: false, category: 'authorization',
        detail: `The service account is valid but has no access to ${packageName}. In Google Play Console open Users and permissions, invite the service account’s email, and give it access to this app.` };
  }
  if (status === 404) {
    return { ok: false, category: 'authorization',
      detail: `Google Play has no app called ${packageName} that this service account can see. Check the package name.` };
  }
  if (status === 429) return { ok: false, category: 'unknown', detail: 'Google Play is limiting requests right now. Try again in a minute.' };
  if (status < 200 || status >= 300) return { ok: false, category: 'unknown', detail: `Google Play answered ${status}.` };
  return null;
}

type PlayApps = { ok: true; apps: Array<{ packageName: string; name: string }> } | { ok: false; status: number };

/** The apps this account can see, from Google's reporting API. That API has to
 * be switched on in the service account's Google Cloud project; when it is
 * not, this answers `ok: false` and the caller falls back to named packages. */
async function searchGooglePlayApps(accessToken: string, opts: StoreCallOptions): Promise<PlayApps> {
  const response = await boundedFetch(opts)(GOOGLE_PLAY_APPS, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'josi-ce' },
  });
  if (!response.ok) return { ok: false, status: response.status };
  const body: any = await response.json().catch(() => null);
  const rows: any[] = Array.isArray(body?.apps) ? body.apps.slice(0, 25) : [];
  return { ok: true, apps: rows.filter((v) => typeof v?.packageName === 'string' && isPackageName(v.packageName))
    .map((v) => ({ packageName: v.packageName, name: clip(v.displayName, 200) || v.packageName })) };
}

/** Ask Google whether this service account works.
 *
 * The key is the account's, so it is checked as an account: Google has to
 * accept it, and then either it can list its apps or it can read each package
 * the person named. A key Google accepts that can do neither yet is still
 * saved, with a sentence saying what to switch on, because the key is good. */
export async function checkGooglePlayKey(values: Record<string, string | undefined>, opts: StoreCallOptions = {}): Promise<DeveloperCheck> {
  const normal = normalizeGooglePlayFields(values);
  if (!normal.ok) return { ok: false, category: 'authentication', detail: normal.detail };
  const packages = googlePlayPackages(normal.values.packageName);
  try {
    const token = await exchangeGoogleToken(normal.values.serviceAccountJson, opts);
    if (!token.ok) return token.check;
    // Named by its Google Cloud project. The service account's email is left
    // out of everything this server says back, like the rest of the key file.
    const file = JSON.parse(normal.values.serviceAccountJson) as { project_id?: string; private_key_id?: string };
    const label = file.project_id ? `Project ${file.project_id}`
      : file.private_key_id ? `Service account key ${file.private_key_id.slice(0, 8)}` : 'Service account';
    for (const packageName of packages.slice(0, 5)) {
      const response = await boundedFetch(opts)(`${GOOGLE_PLAY_API}/${encodeURIComponent(packageName)}/reviews?maxResults=1`, {
        headers: { authorization: `Bearer ${token.accessToken}`, accept: 'application/json', 'user-agent': 'josi-ce' },
      });
      const body: any = await response.json().catch(() => null);
      const refusal = googlePlayRefusal(response.status, body, packageName);
      if (refusal) return refusal;
    }
    if (packages.length) return { ok: true, accountLabel: label, detail: 'Connected.' };
    const found = await searchGooglePlayApps(token.accessToken, opts);
    if (found.ok) {
      return { ok: true, accountLabel: label,
        detail: found.apps.length ? `Connected. ${found.apps.length} app${found.apps.length === 1 ? '' : 's'} visible.`
          : 'Connected, but this service account cannot see any app yet. Invite its email in Google Play Console → Users and permissions.' };
    }
    return { ok: true, accountLabel: label,
      detail: 'Connected. Google accepted the key, but the list of apps is not available: switch on the Google Play Developer Reporting API '
        + 'in the service account’s Google Cloud project, or name the package when asking.' };
  } catch {
    return { ok: false, category: 'network', detail: 'Google could not be reached from this server.' };
  }
}

// ---------------------------------------------------------------- resources

/** The team's apps, or one app's most recent customer reviews. Read-only. */
export async function listAppStoreConnectResources(values: Record<string, string | undefined>, opts: StoreCallOptions & { appId?: string } = {}): Promise<DeveloperResource[]> {
  const normal = normalizeAppStoreConnectFields(values);
  if (!normal.ok) throw new Error('The App Store Connect key is unreadable.');
  const appId = (opts.appId ?? '').trim();
  if (appId && !/^[0-9]{1,20}$/.test(appId)) throw new Error('An App Store Connect app id is a number.');
  const url = appId
    ? `${APPLE_API}/v1/apps/${appId}/customerReviews?limit=25&sort=-createdDate`
    : `${APPLE_API}/v1/apps?limit=25`;
  const response = await boundedFetch(opts)(url, {
    headers: { authorization: `Bearer ${mintAppStoreConnectToken(normal.values)}`, accept: 'application/json', 'user-agent': 'josi-ce' },
  });
  if (!response.ok) throw new Error(`App Store Connect refused resource discovery (${response.status}).`);
  const body: any = await response.json();
  const rows: any[] = Array.isArray(body?.data) ? body.data.slice(0, 25) : [];
  if (!appId) {
    return rows.filter((v) => v?.id && v?.attributes?.name).map((v) => ({
      id: String(v.id), name: clip(v.attributes.name, 200), kind: 'app',
      ...(v.attributes.bundleId ? { detail: clip(v.attributes.bundleId, 200) } : {}),
    }));
  }
  return rows.filter((v) => v?.id).map((v) => {
    const rating = Number(v.attributes?.rating);
    const when = clip(v.attributes?.createdDate, 40);
    const territory = clip(v.attributes?.territory, 10);
    return {
      id: String(v.id), name: clip(v.attributes?.title, 200) || 'Untitled review', kind: 'review',
      ...(Number.isFinite(rating) ? { rating } : {}),
      detail: [clip(v.attributes?.body, 500), [when, territory].filter(Boolean).join(' · ')].filter(Boolean).join(' — '),
    };
  });
}

/** One app's most recent reviews, or the apps this account can see.
 *
 * `appId` is a package name. Without one: a key saved with exactly one package
 * reads that app's reviews (what it always did); otherwise the apps are listed,
 * from Google where it will say and from the saved package names where it will
 * not. Read-only. */
export async function listGooglePlayResources(values: Record<string, string | undefined>, opts: StoreCallOptions & { appId?: string } = {}): Promise<DeveloperResource[]> {
  const normal = normalizeGooglePlayFields(values);
  if (!normal.ok) throw new Error('The Google Play key is unreadable.');
  const saved = googlePlayPackages(normal.values.packageName);
  const asked = (opts.appId ?? '').trim();
  if (asked && !isPackageName(asked)) throw new Error('A Google Play app is named by its package name, like com.example.app.');
  const token = await exchangeGoogleToken(normal.values.serviceAccountJson, opts);
  if (!token.ok) throw new Error('Google refused the service account.');
  const packageName = asked || (saved.length === 1 ? saved[0] : '');
  if (!packageName) {
    const found = await searchGooglePlayApps(token.accessToken, opts);
    const apps = new Map<string, string>(saved.map((p) => [p, p]));
    if (found.ok) for (const app of found.apps) apps.set(app.packageName, app.name);
    if (!found.ok && !apps.size) throw new Error(`Google Play would not list this account's apps (${found.status}).`);
    return [...apps].slice(0, 25).map(([id, name]) => ({ id, name, kind: 'app', detail: id }));
  }
  const response = await boundedFetch(opts)(`${GOOGLE_PLAY_API}/${encodeURIComponent(packageName)}/reviews?maxResults=25`, {
    headers: { authorization: `Bearer ${token.accessToken}`, accept: 'application/json', 'user-agent': 'josi-ce' },
  });
  if (!response.ok) throw new Error(`Google Play refused resource discovery (${response.status}).`);
  const body: any = await response.json();
  const rows: any[] = Array.isArray(body?.reviews) ? body.reviews.slice(0, 25) : [];
  return rows.filter((v) => v?.reviewId).map((v) => {
    const comment = Array.isArray(v.comments) ? v.comments.find((c: any) => c?.userComment)?.userComment : null;
    const rating = Number(comment?.starRating);
    const seconds = Number(comment?.lastModified?.seconds);
    const when = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
    return {
      id: String(v.reviewId), name: clip(v.authorName, 200) || 'Anonymous', kind: 'review',
      ...(Number.isFinite(rating) ? { rating } : {}),
      detail: [clip(comment?.text, 500), when].filter(Boolean).join(' — '),
    };
  });
}
