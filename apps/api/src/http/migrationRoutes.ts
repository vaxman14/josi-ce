import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type { Db } from '@josi-ce/core';
import {
  LIMITS, MigrationError, commitMigration, listMigrationBatches, migrationScope,
  previewMigration, readMigrationArchive, readMigrationBatch, rollbackMigration, scanMigration,
  searchMigrationArchives, selectable, selectMigration, unpackUploads,
  type MigrationManifest, type MigrationReceipt, type MigrationScope, type MigrationSource,
} from '@josi-ce/persona';
import { requireAuth } from './authz.js';
import { param } from './async.js';

interface Preview {
  scope: MigrationScope;
  expires: number;
  scanned?: MigrationManifest;
  reviewed?: MigrationManifest;
  revision?: string;
  receipt?: MigrationReceipt;
  busy: boolean;
  size: number;
}

/** Aggregate limit enforced WHILE streaming, not after memoryStorage has
 * buffered N independently max-sized files. No temp files are ever written. */
function receiveUpload() {
  let total = 0;
  const storage: multer.StorageEngine = {
    _handleFile(_req, file, done) {
      const chunks: Buffer[] = [];
      let size = 0, failed = false;
      file.stream.on('data', (chunk: Buffer) => {
        total += chunk.length; size += chunk.length;
        if (!failed && (total > LIMITS.uploadBytes || size > (/\.zip$/i.test(file.originalname) ? LIMITS.uploadBytes : LIMITS.entryBytes))) {
          failed = true; chunks.forEach(buffer => buffer.fill(0)); chunks.length = 0;
          done(new MigrationError('Upload exceeds the 8 MiB total or 1 MiB individual-file limit.', 413));
        }
        if (!failed) chunks.push(chunk);
      });
      file.stream.on('error', () => { if (!failed) { failed = true; done(new MigrationError('Upload interrupted.')); } });
      file.stream.on('end', () => { if (!failed) done(null, { buffer: Buffer.concat(chunks), size }); });
    },
    _removeFile(_req, file, done) { file.buffer?.fill(0); done(null); },
  };
  return multer({ storage, preservePath: true, limits: { files: LIMITS.uploadFiles, fileSize: LIMITS.uploadBytes, fields: 0, parts: LIMITS.uploadFiles } }).array('files', LIMITS.uploadFiles);
}

export function migrationRoutes(db: Db): Router {
  const router = Router();
  const previews = new Map<string, Preview>();
  const uploads = new Set<string>();
  // Bounded, expiring process memory. Restarts discard previews; no raw archive,
  // plaintext staging table or client-supplied manifest is ever authoritative.
  const clean = () => { for (const [id, preview] of previews) if (!preview.busy && preview.expires <= Date.now()) previews.delete(id); };
  const timer = setInterval(clean, 30_000); timer.unref();
  const memorySize = () => [...previews.values()].reduce((sum, preview) => sum + preview.size, 0);
  const fit = () => { if (previews.size >= 20 || memorySize() > 32 * 1024 * 1024) throw new MigrationError('Migration preview capacity is full. Close another preview or try again shortly.', 429); };
  router.use(requireAuth, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const handle = (fn: (req: Request, res: Response, scope: MigrationScope) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req, res, await migrationScope(db, req.user!.id)); }
    catch (error) {
      // Do not log errors: postgres errors can include the complete failed row.
      const known = error instanceof MigrationError;
      if (!res.headersSent) res.status(known ? error.status : 500).json({ error: known ? error.message : 'Migration could not be completed. No partial import was saved. Try again.' });
    }
  };
  const get = (id: string, scope: MigrationScope) => {
    clean();
    const preview = previews.get(id);
    if (!preview || preview.scope.ownerUserId !== scope.ownerUserId || preview.scope.installationId !== scope.installationId) {
      throw new MigrationError('Preview not found or expired. Scan your files again.', 404);
    }
    if (preview.busy) throw new MigrationError('This migration is already being committed.', 409);
    return preview;
  };
  const offset = (req: Request) => {
    const value = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw new MigrationError('Invalid page.');
    return value;
  };
  router.post('/scan', handle(async (req, res, scope) => {
    const source = (req.query.source ?? 'auto') as MigrationSource | 'auto';
    if (!['auto', 'openclaw', 'hermes', 'josi'].includes(source)) throw new MigrationError('Choose a supported source.');
    clean(); fit();
    if (uploads.has(scope.ownerUserId) || uploads.size >= 2) throw new MigrationError('Another scan is in progress. Try again shortly.', 429);
    uploads.add(scope.ownerUserId);
    try {
      await new Promise<void>((resolve, reject) => receiveUpload()(req, res, error => error ? reject(error) : resolve())).catch(() => {
        throw new MigrationError('Upload refused. Choose one ZIP or 1–100 files, within 8 MiB total and 1 MiB per expanded file.', 413);
      });
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const unpacked = unpackUploads(files.map(file => ({ path: file.originalname, bytes: file.buffer })));
      let scanned: MigrationManifest;
      try { scanned = scanMigration(unpacked, source); } finally { unpacked.forEach(file => file.bytes.fill(0)); }
      const report = await previewMigration(db, scope, scanned);
      const size = Buffer.byteLength(JSON.stringify(scanned));
      if (memorySize() + size > 32 * 1024 * 1024) throw new MigrationError('Preview capacity exceeded. Use a smaller export.', 413);
      // Only one unfinished preview per owner. An old tab gets a clear expiry.
      for (const [id, preview] of previews) if (preview.scope.ownerUserId === scope.ownerUserId && !preview.busy && !preview.receipt) previews.delete(id);
      const id = randomUUID(), expires = Date.now() + LIMITS.previewMs;
      previews.set(id, { scope, expires, scanned, size, busy: false });
      res.json({ previewId: id, expiresAt: new Date(expires).toISOString(), manifest: report, limits: LIMITS });
    } finally {
      (req.files as Express.Multer.File[] | undefined)?.forEach(file => file.buffer?.fill(0));
      uploads.delete(scope.ownerUserId);
    }
  }));
  router.post('/:id/review', handle(async (req, res, scope) => {
    const preview = get(param(req, 'id'), scope);
    if (!preview.scanned || preview.receipt) throw new MigrationError('Migration is already committed.', 409);
    preview.busy = true;
    try {
      const reviewed = await previewMigration(db, scope, selectMigration(preview.scanned, req.body?.selections));
      const size = Buffer.byteLength(JSON.stringify(preview.scanned)) + Buffer.byteLength(JSON.stringify(reviewed));
      if (memorySize() - preview.size + size > 32 * 1024 * 1024) throw new MigrationError('Preview capacity exceeded. Use a smaller selection.', 413);
      preview.size = size; preview.reviewed = reviewed; preview.revision = randomUUID();
      res.json({ revision: preview.revision, manifest: reviewed });
    } finally { preview.busy = false; }
  }));
  router.post('/:id/commit', handle(async (req, res, scope) => {
    const id = param(req, 'id'), preview = get(id, scope);
    if (preview.receipt) return res.json({ receipt: preview.receipt });
    if (!preview.reviewed || req.body?.revision !== preview.revision || req.body?.confirm !== 'import') throw new MigrationError('Review this selection before importing.', 409);
    if (!preview.reviewed.items.some(selectable)) throw new MigrationError('There are no selected supported items to import.');
    preview.busy = true;
    try {
      preview.receipt = await commitMigration(db, scope, preview.reviewed, id);
      delete preview.scanned; delete preview.reviewed; preview.size = Buffer.byteLength(JSON.stringify(preview.receipt));
      res.json({ receipt: preview.receipt });
    } finally { preview.busy = false; }
  }));
  router.delete('/previews/:id', handle(async (req, res, scope) => { get(param(req, 'id'), scope); previews.delete(param(req, 'id')); res.json({ discarded: true }); }));
  router.get('/batches', handle(async (req, res, scope) => res.json({ batches: await listMigrationBatches(db, scope, offset(req)) })));
  router.get('/batches/:id', handle(async (req, res, scope) => res.json(await readMigrationBatch(db, scope, param(req, 'id')))));
  router.post('/batches/:id/rollback', handle(async (req, res, scope) => {
    if (req.body?.confirm !== 'rollback') throw new MigrationError('Confirm rollback of this batch.');
    const result = await rollbackMigration(db, scope, param(req, 'id'));
    previews.delete(param(req, 'id'));
    res.json(result);
  }));
  router.get('/archives', handle(async (req, res, scope) => {
    if (req.query.q !== undefined && typeof req.query.q !== 'string') throw new MigrationError('Invalid search.');
    res.json({ archives: await searchMigrationArchives(db, scope, req.query.q as string ?? '', offset(req)) });
  }));
  router.get('/archives/:id', handle(async (req, res, scope) => res.json({ archive: await readMigrationArchive(db, scope, param(req, 'id')) })));
  return router;
}
