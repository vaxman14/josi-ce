import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import multer from 'multer';

/** Receives one backup archive into `incomingDir`, named `<prefix>-<uuid>`.
 *
 * The folder is made per upload rather than when the routes are built. Given a
 * string destination multer creates it in its constructor and throws, so a data
 * folder that is missing or read-only would stop the whole server from starting
 * over a feature nobody has used yet. Here it fails that one upload instead. */
export function archiveUpload(incomingDir: string, prefix: string): multer.Multer {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, done) => {
        mkdir(incomingDir, { recursive: true }).then(() => done(null, incomingDir), (error: Error) => done(error, incomingDir));
      },
      filename: (_req, _file, done) => done(null, `${prefix}-${randomUUID()}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
  });
}
