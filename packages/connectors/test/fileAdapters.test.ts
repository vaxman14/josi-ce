// The file adapters, with the providers played by a stub.
//
// What is real: the URLs Josi builds, the fields it asks for, the shape it
// reduces both dialects to, the size ceiling, and the refusals. No network.
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../src/providers.js';
import {
  FileTooLarge, assertEntryId, downloadEntry, listFolderPage, type RemoteEntry,
} from '../src/providers/files.js';
import { sanitizeRemoteName } from '../src/storageSync.js';

function stub(handler: (url: string) => { status?: number; json?: unknown; bytes?: Buffer }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const href = String(url);
    calls.push(href);
    const out = handler(href);
    if (out.bytes) return new Response(new Uint8Array(out.bytes), { status: out.status ?? 200 });
    return new Response(JSON.stringify(out.json ?? {}), {
      status: out.status ?? 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const entry = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  sourceId: 'file-1', name: 'notes.txt', folder: false, byteSize: 5,
  modifiedAt: '2026-09-01T00:00:00Z', exportMime: null, exportExtension: null,
  unreadable: false, ...over,
});

describe('listing a Google Drive folder', () => {
  it('asks for exactly the fields Josi uses, scoped to the folder, untrashed', async () => {
    const { fetchImpl, calls } = stub(() => ({ json: { files: [] } }));
    await listFolderPage('google', { accessToken: 't', folderId: 'abc123' }, { fetchImpl });
    const url = new URL(calls[0]);
    expect(url.searchParams.get('q')).toBe("'abc123' in parents and trashed = false");
    expect(url.searchParams.get('fields')).toContain('files(id, name, mimeType, size, modifiedTime)');
    expect(url.searchParams.get('fields')).not.toMatch(/owners|permissions|thumbnail/);
  });

  it('reduces folders, plain files and Google-native documents to one shape', async () => {
    const { fetchImpl } = stub(() => ({
      json: {
        files: [
          { id: 'f1', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'f2', name: 'notes.txt', mimeType: 'text/plain', size: '42', modifiedTime: '2026-01-01T00:00:00Z' },
          { id: 'f3', name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
          { id: 'f4', name: 'Numbers', mimeType: 'application/vnd.google-apps.spreadsheet' },
          { id: 'f5', name: 'Quiz', mimeType: 'application/vnd.google-apps.form' },
        ],
      },
    }));
    const page = await listFolderPage('google', { accessToken: 't', folderId: 'root' }, { fetchImpl });
    const byId = Object.fromEntries(page.entries.map((e) => [e.sourceId, e]));
    expect(byId.f1.folder).toBe(true);
    expect(byId.f2.byteSize).toBe(42);
    // Native documents read via export, with the exported format's extension.
    expect(byId.f3.exportMime).toBe('text/plain');
    expect(byId.f3.exportExtension).toBe('txt');
    expect(byId.f4.exportExtension).toBe('csv');
    // A Form has no readable byte form and says so, rather than vanishing.
    expect(byId.f5.unreadable).toBe(true);
  });

  it('pages with the provider token', async () => {
    const { fetchImpl, calls } = stub((url) => (
      url.includes('pageToken=next-1')
        ? { json: { files: [] } }
        : { json: { files: [], nextPageToken: 'next-1' } }
    ));
    const first = await listFolderPage('google', { accessToken: 't', folderId: 'root' }, { fetchImpl });
    expect(first.nextPageCursor).toBe('next-1');
    const second = await listFolderPage('google', {
      accessToken: 't', folderId: 'root', pageCursor: first.nextPageCursor,
    }, { fetchImpl });
    expect(second.nextPageCursor).toBeNull();
    expect(calls[1]).toContain('pageToken=next-1');
  });
});

describe('listing a OneDrive folder', () => {
  it('selects only the fields Josi uses and reduces to the same shape', async () => {
    const { fetchImpl, calls } = stub(() => ({
      json: {
        value: [
          { id: 'd1', name: 'Reports', folder: { childCount: 2 }, size: 0 },
          { id: 'd2', name: 'notes.txt', file: {}, size: 42, lastModifiedDateTime: '2026-01-01T00:00:00Z' },
        ],
      },
    }));
    const page = await listFolderPage('microsoft', { accessToken: 't', folderId: 'root' }, { fetchImpl });
    expect(calls[0]).toContain('/me/drive/items/root/children');
    expect(page.entries[0].folder).toBe(true);
    expect(page.entries[1].byteSize).toBe(42);
  });

  it('follows only Graph-hosted page cursors — a cursor is not a licence to fetch anywhere', async () => {
    const { fetchImpl } = stub(() => ({ json: { value: [] } }));
    await expect(listFolderPage('microsoft', {
      accessToken: 't', folderId: 'root', pageCursor: 'https://evil.example/steal',
    }, { fetchImpl })).rejects.toThrow(/not a microsoft graph page cursor/i);
  });
});

describe('downloading', () => {
  it('uses alt=media for a plain file and export for a Google-native one', async () => {
    const { fetchImpl, calls } = stub(() => ({ bytes: Buffer.from('hello') }));
    await downloadEntry('google', { accessToken: 't', entry: entry(), maxBytes: 100 }, { fetchImpl });
    expect(calls[0]).toContain('alt=media');
    await downloadEntry('google', {
      accessToken: 't',
      entry: entry({ sourceId: 'doc-1', exportMime: 'text/plain', exportExtension: 'txt' }),
      maxBytes: 100,
    }, { fetchImpl });
    expect(calls[1]).toContain('/export?mimeType=text%2Fplain');
  });

  it('refuses bytes past the ceiling — the late check that covers exports of unknown size', async () => {
    const { fetchImpl } = stub(() => ({ bytes: Buffer.alloc(50) }));
    await expect(downloadEntry('google', {
      accessToken: 't', entry: entry(), maxBytes: 10,
    }, { fetchImpl })).rejects.toBeInstanceOf(FileTooLarge);
  });

  it('refuses an entry the provider itself calls unreadable', async () => {
    const { fetchImpl } = stub(() => ({ bytes: Buffer.alloc(1) }));
    await expect(downloadEntry('google', {
      accessToken: 't', entry: entry({ unreadable: true }), maxBytes: 10,
    }, { fetchImpl })).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe('failure classification', () => {
  it.each([
    [401, 'expired'],
    [403, 'insufficient_scope'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ] as const)('%s becomes the %s category, never the body', async (status, category) => {
    const { fetchImpl } = stub(() => ({
      status, json: { error: { message: 'quotes /Legal/Q3-layoffs.docx' } },
    }));
    const err = await listFolderPage('google', { accessToken: 't', folderId: 'root' }, { fetchImpl })
      .then(() => null, (e) => e as ConnectorError);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err!.category).toBe(category);
    expect(err!.message).not.toContain('Q3-layoffs');
  });
});

describe('identifiers and names', () => {
  it('refuses an id shaped like an injection before it reaches a URL', () => {
    expect(() => assertEntryId('google', "x' or '1'='1")).toThrow(ConnectorError);
    expect(() => assertEntryId('google', 'ok_id-123')).not.toThrow();
    expect(assertEntryId('microsoft', 'DRIVE!123.456')).toBe('DRIVE!123.456');
  });

  it('defangs remote names the path constraints would refuse', () => {
    // The database refuses '..' anywhere and '/' would change the tree shape.
    expect(sanitizeRemoteName('..secret')).not.toContain('..');
    expect(sanitizeRemoteName('a/b\\c')).toBe('a_b_c');
    expect(sanitizeRemoteName('....')).not.toContain('..');
    expect(sanitizeRemoteName('   ')).toBe('_');
    expect(sanitizeRemoteName('plain.txt')).toBe('plain.txt');
  });
});
