// The staging folder for an uploaded backup is the upload's problem, never the
// server's: building the routes must survive a data folder it cannot write to.
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveUpload } from '../src/http/archiveUpload.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-archive-upload-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function post(incoming: string): Promise<{ status: number; body: { path?: string } }> {
  const app = express();
  app.post('/', (req, res) => archiveUpload(incoming, 'test').single('archive')(req, res, (error: unknown) => {
    if (error) { res.status(400).json({}); return; }
    res.json({ path: req.file?.path });
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const form = new FormData();
    form.append('archive', new Blob(['backup bytes']), 'backup.zip');
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() as { path?: string } };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe('receiving a backup archive', () => {
  it('touches nothing until a file arrives', () => {
    const incoming = join(dir, 'never', 'made');
    expect(() => archiveUpload(incoming, 'test')).not.toThrow();
    expect(existsSync(incoming)).toBe(false);
  });

  it('makes the folder for the upload and stores the file under its prefix', async () => {
    const incoming = join(dir, 'made', 'on', 'upload');
    const { status, body } = await post(incoming);
    expect(status).toBe(200);
    expect(body.path!.startsWith(join(incoming, 'test-'))).toBe(true);
    expect(readFileSync(body.path!, 'utf8')).toBe('backup bytes');
  });

  it('fails only that upload when the folder cannot be made', async () => {
    // A file where a parent folder should be stands in for a read-only /data.
    const { status } = await post(join(import.meta.filename, 'incoming'));
    expect(status).toBe(400);
  });
});
