// Reading files and folders at Google Drive and OneDrive.
//
// One shape in and out, two dialects underneath — the same arrangement as
// providers/contacts.ts, and for the same reason: everything above this file
// works with `RemoteEntry` and never learns which provider produced it.
//
// READ-ONLY BY CONSTRUCTION. There is no write, move, rename or delete in this
// file, and none is planned for this round. The OAuth scopes the storage
// capabilities ask for (`drive.readonly`, `Files.Read`) could not write even
// if a function here tried — but the absence of the function is the control
// that can be reviewed.
//
// NOTHING HERE LOGS A FILE. Provider error bodies quote the request, and a
// request to a files API quotes folder and file names. Failures become a
// CATEGORY, exactly as everywhere else in this package.
import type { Provider } from '../capabilities.js';
import { ConnectorError, type ErrorCategory, type FetchOptions } from '../providers.js';

/** A file or folder as a provider describes it, reduced to what Josi needs. */
export interface RemoteEntry {
  /** The provider's own stable id. Survives a rename. */
  sourceId: string;
  name: string;
  folder: boolean;
  /** Bytes, when the provider states them. Google-native documents have no
   * byte size until they are exported; 0 means "unknown, cap at download". */
  byteSize: number;
  modifiedAt: string | null;
  /** Google-native formats (Docs, Sheets, Slides) need an export, not a
   * download. Null for ordinary files. */
  exportMime: string | null;
  /** The extension Josi should treat this as having. For a Google-native
   * document that is the EXPORTED format's extension, not the (absent) real
   * one. Null means "use the filename as it stands". */
  exportExtension: string | null;
  /** True when the provider says this entry cannot be read as bytes at all —
   * for example a Google Form or Map. Listed so the owner sees it counted,
   * skipped honestly rather than silently absent. */
  unreadable: boolean;
}

export interface EntryPage {
  entries: RemoteEntry[];
  /** More pages in THIS folder. Null when the folder is fully read. */
  nextPageCursor: string | null;
}

export interface ListArgs {
  accessToken: string;
  /** The provider's id for the folder whose children to list. */
  folderId: string;
  pageCursor?: string | null;
  pageSize?: number;
}

const GOOGLE_DRIVE = 'https://www.googleapis.com/drive/v3';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** How each Google-native format is read.
 *
 * Text-bearing formats export as text; everything else Google-native (Forms,
 * Maps, Sites…) has no byte representation Josi can read and is surfaced as
 * unreadable rather than silently dropped. */
const GOOGLE_EXPORTS: Record<string, { mime: string; extension: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', extension: 'txt' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', extension: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', extension: 'txt' },
};

// ------------------------------------------------------------------ shared

interface HttpResult {
  status: number;
  body: unknown;
  raw: ArrayBuffer | null;
}

async function request(
  url: string,
  init: RequestInit,
  opts: FetchOptions,
  wantBytes = false,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    if (wantBytes && res.ok) {
      return { status: res.status, body: null, raw: await res.arrayBuffer() };
    }
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body, raw: null };
  } catch {
    throw new ConnectorError('could not reach the provider', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/** A provider's short error code, if it gave one that is safe to repeat.
 * Codes only — a files API's `message` field quotes folder and file names. */
function safeCode(body: unknown): string | null {
  const err = (body as { error?: { status?: unknown; code?: unknown } } | null)?.error;
  for (const candidate of [err?.status, err?.code]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) return candidate;
  }
  return null;
}

function classify(status: number, code: string | null): { category: ErrorCategory; revoked: boolean } {
  if (status === 401) return { category: 'expired', revoked: false };
  if (status === 403) return { category: 'insufficient_scope', revoked: false };
  if (status === 429) return { category: 'rate_limited', revoked: false };
  if (code === 'invalid_grant') return { category: 'revoked', revoked: true };
  return { category: 'provider_error', revoked: false };
}

function raise(status: number, body: unknown): never {
  const code = safeCode(body);
  const { category, revoked } = classify(status, code);
  throw new ConnectorError(
    code ? `the provider refused the request (${code})` : 'the provider refused the request',
    { category, revoked, status },
  );
}

/** A folder or file id, as this provider issues them.
 *
 * Checked before an id is placed into a URL or a query expression. An id
 * arrives from our own database or from the provider's own listing, so a
 * mismatch is corruption or an attack — either way the answer is a refusal,
 * not an escape. Google ids are URL-safe base64; Graph ids add `!` and `.`. */
const ID_SHAPE: Record<Provider, RegExp> = {
  google: /^[A-Za-z0-9_-]{1,200}$/,
  microsoft: /^[A-Za-z0-9!._-]{1,250}$/,
};

export function assertEntryId(provider: Provider, id: string): string {
  if (!ID_SHAPE[provider].test(id)) {
    throw new ConnectorError('that is not a folder or file id this provider issues', {
      category: 'provider_error',
    });
  }
  return id;
}

/** Thrown by `downloadEntry` when the bytes exceed the ceiling. A category of
 * its own rather than a ConnectorError: the provider did nothing wrong, and
 * the caller records `too_large` against the document. */
export class FileTooLarge extends Error {}

// ------------------------------------------------------------------ google

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function googleEntry(item: Record<string, unknown>): RemoteEntry | null {
  const sourceId = str(item.id);
  const name = str(item.name) ?? '';
  if (!sourceId || !name) return null;
  const mime = str(item.mimeType) ?? '';
  const nativeExport = GOOGLE_EXPORTS[mime] ?? null;
  const nativeUnreadable = mime.startsWith('application/vnd.google-apps.') && !nativeExport
    && mime !== GOOGLE_FOLDER_MIME;
  return {
    sourceId,
    name,
    folder: mime === GOOGLE_FOLDER_MIME,
    byteSize: typeof item.size === 'string' ? Number(item.size) : Number(item.size ?? 0) || 0,
    modifiedAt: str(item.modifiedTime),
    exportMime: nativeExport?.mime ?? null,
    exportExtension: nativeExport?.extension ?? null,
    unreadable: nativeUnreadable,
  };
}

async function listGoogle(args: ListArgs, opts: FetchOptions): Promise<EntryPage> {
  const folderId = assertEntryId('google', args.folderId);
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    // Exactly the fields Josi uses, and no more. Asking for owners, permissions
    // and thumbnails because they are available would mean holding them.
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
    pageSize: String(args.pageSize ?? 100),
  });
  if (args.pageCursor) params.set('pageToken', args.pageCursor);

  const res = await request(`${GOOGLE_DRIVE}/files?${params}`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  }, opts);
  if (res.status !== 200) raise(res.status, res.body);

  const body = res.body as { nextPageToken?: unknown; files?: unknown[] };
  const entries = (Array.isArray(body.files) ? body.files : [])
    .map((f) => googleEntry(f as Record<string, unknown>))
    .filter((e): e is RemoteEntry => e !== null);
  return { entries, nextPageCursor: str(body.nextPageToken) };
}

async function downloadGoogle(
  args: { accessToken: string; entry: RemoteEntry; maxBytes: number },
  opts: FetchOptions,
): Promise<Buffer> {
  const id = assertEntryId('google', args.entry.sourceId);
  const url = args.entry.exportMime
    ? `${GOOGLE_DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(args.entry.exportMime)}`
    : `${GOOGLE_DRIVE}/files/${id}?alt=media`;
  const res = await request(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  }, opts, true);
  if (res.status !== 200 || !res.raw) raise(res.status, res.body);
  if (res.raw.byteLength > args.maxBytes) throw new FileTooLarge('larger than the configured ceiling');
  return Buffer.from(res.raw);
}

// --------------------------------------------------------------- microsoft

function graphEntry(item: Record<string, unknown>): RemoteEntry | null {
  const sourceId = str(item.id);
  const name = str(item.name) ?? '';
  if (!sourceId || !name) return null;
  return {
    sourceId,
    name,
    folder: typeof item.folder === 'object' && item.folder !== null,
    byteSize: Number(item.size ?? 0) || 0,
    modifiedAt: str(item.lastModifiedDateTime),
    exportMime: null,
    exportExtension: null,
    unreadable: false,
  };
}

async function listGraph(args: ListArgs, opts: FetchOptions): Promise<EntryPage> {
  // Graph pages with a full `@odata.nextLink` URL. It is used only when it
  // points back at Graph itself — a cursor is not a licence to fetch anywhere.
  let url: string;
  if (args.pageCursor) {
    if (!args.pageCursor.startsWith(`${GRAPH_BASE}/`)) {
      throw new ConnectorError('that is not a Microsoft Graph page cursor', { category: 'provider_error' });
    }
    url = args.pageCursor;
  } else {
    const folderId = assertEntryId('microsoft', args.folderId);
    const params = new URLSearchParams({
      $select: 'id,name,size,folder,file,lastModifiedDateTime',
      $top: String(args.pageSize ?? 100),
    });
    url = `${GRAPH_BASE}/me/drive/items/${folderId}/children?${params}`;
  }

  const res = await request(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  }, opts);
  if (res.status !== 200) raise(res.status, res.body);

  const body = res.body as { '@odata.nextLink'?: unknown; value?: unknown[] };
  const entries = (Array.isArray(body.value) ? body.value : [])
    .map((v) => graphEntry(v as Record<string, unknown>))
    .filter((e): e is RemoteEntry => e !== null);
  return { entries, nextPageCursor: str(body['@odata.nextLink']) };
}

async function downloadGraph(
  args: { accessToken: string; entry: RemoteEntry; maxBytes: number },
  opts: FetchOptions,
): Promise<Buffer> {
  const id = assertEntryId('microsoft', args.entry.sourceId);
  // Graph answers /content with a 302 to a short-lived download URL; fetch
  // follows it. The redirect target carries its own authorization.
  const res = await request(`${GRAPH_BASE}/me/drive/items/${id}/content`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  }, opts, true);
  if (res.status !== 200 || !res.raw) raise(res.status, res.body);
  if (res.raw.byteLength > args.maxBytes) throw new FileTooLarge('larger than the configured ceiling');
  return Buffer.from(res.raw);
}

// ----------------------------------------------------------------- facade

/** One page of a folder's direct children. */
export async function listFolderPage(
  provider: Provider,
  args: ListArgs,
  opts: FetchOptions = {},
): Promise<EntryPage> {
  return provider === 'google' ? listGoogle(args, opts) : listGraph(args, opts);
}

/** The bytes of one file, bounded.
 *
 * The ceiling is enforced AFTER the transfer for simplicity — the transfer is
 * already bounded by the provider's own file size, and `maxBytes` here is the
 * installation's `max_file_bytes`, which the metadata gate has usually already
 * applied. The late check exists for Google-native documents, whose exported
 * size is unknown until exported. */
export async function downloadEntry(
  provider: Provider,
  args: { accessToken: string; entry: RemoteEntry; maxBytes: number },
  opts: FetchOptions = {},
): Promise<Buffer> {
  if (args.entry.unreadable) {
    throw new ConnectorError('this entry has no readable byte form', { category: 'provider_error' });
  }
  return provider === 'google' ? downloadGoogle(args, opts) : downloadGraph(args, opts);
}
