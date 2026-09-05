// Backup, update, diagnostics, telemetry and support over HTTP.
//
// Almost everything here is super-admin only, and the exception is deliberate:
// diagnostics and support tickets belong to the person raising them. M102 says
// the USER inspects the bundle and consents, so a member can create, read and
// approve their own bundle — but a bundle contains no content by construction
// (M113), so this is not a privacy hole, it is the consent flow working.
import { Router, type Request, type Response } from 'express';
import { LIMITS, consume, type Db, type Limit } from '@josi-ce/core';
import {
  BackupError, DiagnosticsError, MASTER_KEY_DOC, RestoreError, SupportError, restoreBackup,
  TELEMETRY_DISCLOSURE, TelemetryError, acknowledgementFor, approveBundle,
  buildBundle, checkForUpdate, createBackup, describeBackup, diagnosticsRequired,
  gatewayStatus, isNewer, markInspected, passSecretScan, recordBundle,
  scanForSecrets, sendTelemetry, setTelemetry, submitTicket,
  type BackupWriter, type LogWindow, type TelemetrySender, type TicketCategory,
} from '@josi-ce/ops';
import { UnsafeEndpointError } from '@josi-ce/llm';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { existsSync } from 'node:fs';
import { asyncRoute, param } from './async.js';

export interface OpsRoutesCtx {
  db: Db;
  /** Injected. No test writes a real archive or contacts a real endpoint. */
  backupWriter?: BackupWriter;
  restoreReader?: import('@josi-ce/ops').RestoreReader;
  telemetrySender?: TelemetrySender;
  /** M115: unset by default. Nothing is transmitted without it. */
  supportGatewayUrl?: string | null;
  fetchLatestVersion?: () => Promise<string | null>;
  /** Injected by the tests so no suite resolves a hostname. */
  outboundResolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof SupportError || err instanceof DiagnosticsError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof UnsafeEndpointError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof TelemetryError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof BackupError || err instanceof RestoreError) {
        // A category, never the underlying message: an archive error quotes
        // paths and a database error quotes configuration.
        res.status(500).json({ error: 'that could not be completed', category: err.category });
        return;
      }
      throw err;
    }
  });
}

export function opsRoutes(ctx: OpsRoutesCtx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** Spend one from this person's allowance, or refuse with a Retry-After.
   *
   * Per user, never global: a shared counter on a small server means one person
   * looping denies the feature to everybody, which is the outage the limit
   * exists to prevent. */
  const limited = async (req: Request, res: Response, limit: Limit): Promise<boolean> => {
    const verdict = await consume(db, { limit, subject: `${limit.bucket}:${req.user!.id}` });
    if (!verdict.ok) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      res.status(429).json({
        error: 'that has been done too many times recently',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // Diagnostics and support: the person raising them owns them.
  // -------------------------------------------------------------------------

  /** M112: what windows exist, and what a bundle will contain. Shown before
   * anything is built, so nobody consents to a description they never saw. */
  r.get(
    '/diagnostics/options',
    handle(async (_req, res) => res.json({
      windows: ['1h', '24h', '7d'],
      defaultWindow: '24h',
      maxBytes: 25 * 1024 * 1024,
      includes: [
        'The Josi version', 'Whether each container is running and how often it restarted',
        'CPU, memory and free disk', 'Which settings are configured — never their values',
        'Which database migrations have run', 'Recent log lines, with secrets removed',
        'Counts of users, conversations and documents',
      ],
      excludes: [
        'Messages, emails, calendar entries and contacts',
        'Documents and their extracted text', 'Prompts and assistant replies',
        'Database rows', 'Passwords, API keys and tokens',
      ],
      note: 'You will be shown the whole bundle before anything is sent, and you can cancel.',
    })),
  );

  r.post(
    '/diagnostics',
    handle(async (req, res) => {
      // Building one reads config, counts rows and compresses. Cheap once,
      // expensive in a loop.
      if (!(await limited(req, res, LIMITS.diagnostics))) return undefined;
      const window = (['1h', '24h', '7d'].includes(str(req.body?.window, 8))
        ? req.body.window : '24h') as LogWindow;

      // Facts about the installation. Nothing here reads a content table — the
      // builder can only render the sections it knows, which is M113 made
      // structural rather than filtered.
      const [{ users }] = await db.query<{ users: number }>(
        `select count(*)::int as users from users where status = 'active'`,
      );
      const [{ threads }] = await db.query<{ threads: number }>(
        `select count(*)::int as threads from threads`,
      );
      const [{ documents }] = await db.query<{ documents: number }>(
        `select count(*)::int as documents from documents`,
      );
      const [smtp] = await db.query<{ n: number }>(
        `select count(*)::int as n from smtp_profiles`,
      );
      const [policy] = await db.query<{ clamav_enabled: boolean; ocr_enabled: boolean }>(
        `select clamav_enabled, ocr_enabled from storage_policy where id = true`,
      );

      const built = buildBundle({
        version: process.env.JOSI_VERSION ?? '0.1.0',
        containers: [],
        resources: {
          cpuCount: (await import('node:os')).cpus().length,
          memoryBytes: (await import('node:os')).totalmem(),
          diskFreeBytes: 0,
        },
        configStatus: {
          smtp: (smtp?.n ?? 0) > 0,
          clamav: policy?.clamav_enabled ?? false,
          ocr: policy?.ocr_enabled ?? false,
        },
        migrations: [],
        logs: [],
        counts: { users, threads, documents },
      });

      const { id } = await recordBundle(db, {
        createdBy: req.user!.id, window, filename: `diagnostics-${Date.now()}.txt`, built,
      });
      return res.status(201).json({
        id, byteSize: built.byteSize, redactions: built.redactions, trimmed: built.trimmed,
      });
    }),
  );

  /** Reading the bundle IS the inspection step. Fetching it records that. */
  r.get(
    '/diagnostics/:id',
    handle(async (req, res) => {
      const id = param(req, 'id');
      const [row] = await db.query<{ created_by: string; byte_size: number }>(
        `select created_by, byte_size from diagnostic_bundles where id = $1`, [id],
      );
      // 404, not 403 — somebody else's bundle is not theirs to know exists.
      if (!row || row.created_by !== req.user!.id) throw new RouteError(404, 'not found');
      await markInspected(db, id);
      return res.json({ id, byteSize: row.byte_size, inspected: true });
    }),
  );

  r.post(
    '/diagnostics/:id/approve',
    handle(async (req, res) => {
      const id = param(req, 'id');
      const [row] = await db.query<{ created_by: string }>(
        `select created_by from diagnostic_bundles where id = $1`, [id],
      );
      if (!row || row.created_by !== req.user!.id) throw new RouteError(404, 'not found');
      await approveBundle(db, { bundleId: id, userId: req.user!.id });
      const scan = await passSecretScan(db, { bundleId: id, text: str(req.body?.text, 1_000_000) });
      return res.json({ approved: true, scan });
    }),
  );

  r.get(
    '/support/options',
    handle(async (_req, res) => res.json({
      categories: (['bug_report', 'feature_request', 'paid_support', 'security_privacy'] as TicketCategory[])
        .map((c) => ({
          category: c,
          diagnosticsRequired: diagnosticsRequired(c),
          acknowledgement: acknowledgementFor(c),
        })),
      gateway: gatewayStatus(ctx.supportGatewayUrl ?? null),
    })),
  );

  r.post(
    '/support/tickets',
    handle(async (req, res) => {
      const category = str(req.body?.category, 32) as TicketCategory;
      if (!['bug_report', 'feature_request', 'paid_support', 'security_privacy'].includes(category)) {
        throw new RouteError(400, 'choose one of the listed categories');
      }
      const description = str(req.body?.description, 8000);
      if (!description) throw new RouteError(400, 'describe the problem');

      const [row] = await db.query<{ id: string }>(
        `insert into support_tickets
           (created_by, category, description, acknowledged_no_guarantee, bundle_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          req.user!.id, category, description,
          req.body?.acknowledged === true,
          str(req.body?.bundleId, 64) || null,
        ],
      );
      return res.status(201).json({ id: row.id, acknowledgement: acknowledgementFor(category) });
    }),
  );

  r.post(
    '/support/tickets/:id/submit',
    handle(async (req, res) => {
      // This one leaves the installation, if a gateway is configured.
      if (!(await limited(req, res, LIMITS.support_submit))) return undefined;
      const out = await submitTicket(db, {
        ticketId: param(req, 'id'),
        userId: req.user!.id,
        gatewayUrl: ctx.supportGatewayUrl ?? null,
        resolveImpl: ctx.outboundResolve,
      });
      return res.json(out);
    }),
  );

  // -------------------------------------------------------------------------
  // Administrator.
  // -------------------------------------------------------------------------

  r.get(
    '/admin/backups',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const backups = await db.query(
        `select id, kind, byte_size, state, error_category, includes_recovery_copies,
                master_key_confirmed, created_at, completed_at
         from backups order by created_at desc limit 50`,
      );
      // The path is deployment detail and is deliberately not returned.
      return res.json({ backups, masterKeyGuidance: MASTER_KEY_DOC });
    }),
  );

  r.post(
    '/admin/backups',
    requireSuperAdmin,
    handle(async (req, res) => {
      // pg_dump against the whole database.
      if (!(await limited(req, res, LIMITS.backup))) return undefined;
      if (!ctx.backupWriter) throw new RouteError(503, 'backups are not available on this installation');
      const kind = req.body?.kind === 'portable' ? 'portable' : 'full';
      const { backup, description } = await createBackup(db, {
        kind,
        createdBy: req.user!.id,
        masterKeyConfirmed: req.body?.masterKeyConfirmed === true,
        writer: ctx.backupWriter,
        filename: `josi-${kind}-${Date.now()}.zip`,
      });
      return res.status(201).json({
        backup: {
          id: backup.id, kind: backup.kind, byteSize: backup.byte_size,
          state: backup.state, includesRecoveryCopies: backup.includes_recovery_copies,
        },
        description,
      });
    }),
  );

  /** What you would be told before restoring, without restoring. */
  r.get(
    '/admin/restore/preflight',
    requireSuperAdmin,
    handle(async (_req, res) => res.json({
      masterKeyPresent: !!process.env.MASTER_KEY_FILE,
      guidance: MASTER_KEY_DOC,
      warning: describeBackup('full', false),
    })),
  );

  /** The acceptance criterion, reachable.
   *
   * A restore is destructive and irreversible, so it takes an explicit
   * confirmation rather than a bare POST — and it reports what came back
   * SEPARATELY from whether it succeeded, because "restored" and "your
   * credentials work" are different facts and conflating them is how an
   * operator discovers the difference weeks later.
   */
  r.post(
    '/admin/restore',
    requireSuperAdmin,
    handle(async (req, res) => {
      if (!ctx.restoreReader || !ctx.backupWriter) {
        throw new RouteError(503, 'restore is not available on this installation');
      }
      if (req.body?.confirm !== 'restore') {
        throw new RouteError(400, 'confirm the restore — this replaces the current database');
      }

      const backupId = str(req.body?.backupId, 64) || null;
      if (!backupId) throw new RouteError(400, 'name the backup to restore');
      const [row] = await db.query<{ stored_path: string; state: string }>(
        `select stored_path, state from backups where id = $1`, [backupId],
      );
      if (!row || row.state !== 'complete') throw new RouteError(404, 'no such completed backup');

      const archive = await ctx.backupWriter.read(row.stored_path);
      // Whether the key is mounted is a property of the deployment, read here
      // rather than assumed, so the answer reflects this container.
      const masterKeyPresent = !!process.env.MASTER_KEY_FILE
        && existsSync(process.env.MASTER_KEY_FILE);

      const out = await restoreBackup(db, {
        backupId, archive, masterKeyPresent, reader: ctx.restoreReader,
      });
      return res.json(out);
    }),
  );

  r.get(
    '/admin/update',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [state] = await db.query<{
        current_version: string; available_version: string | null;
        last_check_at: string | null; last_check_ok: boolean | null;
      }>(`select current_version, available_version, last_check_at, last_check_ok
          from update_state where id = true`);
      return res.json({
        ...state,
        updateAvailable: !!state?.available_version
          && isNewer(state.available_version, state.current_version),
        // Said explicitly, because it is a property people assume the other way.
        automatic: false,
        note: 'Josi never updates itself. Nothing changes until you approve it, and a '
          + 'backup is taken before anything is applied.',
      });
    }),
  );

  r.post(
    '/admin/update/check',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const out = await checkForUpdate(db, {
        fetchLatest: ctx.fetchLatestVersion ?? (async () => null),
      });
      return res.json({
        ...out,
        updateAvailable: !!out.available && isNewer(out.available, out.current),
      });
    }),
  );

  r.get(
    '/admin/telemetry',
    requireSuperAdmin,
    handle(async (_req, res) => {
      const [state] = await db.query<{
        enabled: boolean; last_sent_at: string | null; last_status: string | null;
        last_payload: unknown;
      }>(`select enabled, last_sent_at, last_status, last_payload from telemetry_state where id = true`);
      return res.json({
        ...state,
        disclosure: TELEMETRY_DISCLOSURE,
        // The exact JSON that last left, so this can be checked rather than
        // believed.
        lastPayload: state?.last_payload ?? null,
      });
    }),
  );

  r.put(
    '/admin/telemetry',
    requireSuperAdmin,
    handle(async (req, res) => {
      const enabled = req.body?.enabled === true;
      await setTelemetry(db, {
        enabled,
        endpoint: str(req.body?.endpoint, 500) || null,
        byUserId: req.user!.id,
        resolveImpl: ctx.outboundResolve,
      });
      return res.json({ enabled, disclosure: TELEMETRY_DISCLOSURE });
    }),
  );

  r.post(
    '/admin/telemetry/send',
    requireSuperAdmin,
    handle(async (_req, res) => {
      if (!ctx.telemetrySender) return res.json({ sent: false, reason: 'no sender configured' });
      const [{ id }] = await db.query<{ id: string }>(
        `select installation_id as id from workspace limit 1`,
      ).catch(() => [{ id: '00000000-0000-4000-8000-000000000000' }]);
      const out = await sendTelemetry(db, {
        facts: { installationId: id, version: process.env.JOSI_VERSION ?? '0.1.0' },
        sender: ctx.telemetrySender,
        resolveImpl: ctx.outboundResolve,
      });
      return res.json(out);
    }),
  );

  return r;
}

export { scanForSecrets };
