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
  BackupAgentError, BackupError, DiagnosticsError, MASTER_KEY_DOC, RestoreError, SupportError, restoreBackup,
  TELEMETRY_DISCLOSURE, TelemetryError, acknowledgementFor, approveBundle,
  buildBundle, checkForUpdate, createBackup, describeBackup, diagnosticsRequired,
  gatewayStatus, isNewer, markInspected, passSecretScan, recordBundle,
  scanForSecrets, sendTelemetry, setTelemetry, submitTicket, nextRun, runBackupAgent,
  validateRepository, verifyResticSnapshot, type BackupDestination, type CommandRunner, type DestinationKind,
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
  /** Restic process seam. Tests never execute a host binary. */
  resticRunner?: CommandRunner;
  resticSecretRoot?: string;
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
      if (err instanceof BackupAgentError) {
        res.status(409).json({ error: err.message, category: err.category });
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
      // Custom API connections, as COUNTS. How many are defined, how many the
      // assistant can actually reach, and how many individual actions are
      // switched on — which is the number a supporter needs when somebody
      // reports "Josi called our CRM" or "Josi will not call our CRM". Never a
      // name, never a host, never a credential: a host is somebody's internal
      // service and a bundle goes to a third party's ticket system.
      const [customApis] = await db.query<{ total: number; live: number }>(
        `select count(*)::int as total,
                count(*) filter (where enabled)::int as live
           from custom_api_connections`,
      );
      const [customApiActions] = await db.query<{ live: number }>(
        `select count(*)::int as live
           from custom_api_endpoints e join custom_api_connections c on c.id = e.connection_id
          where e.enabled and c.enabled`,
      );

      // External MCP servers, as COUNTS and nothing else. How many people have
      // connected one, how many the assistant can actually reach, and how many
      // individual tools are approved — the numbers a supporter needs when
      // somebody reports "Josi will not use my notes server". Never a host,
      // never a name, never a tool: on somebody's own server the tool names are
      // a fact about them, and a bundle goes to a third party's ticket system.
      const [mcp] = await db.query<{ total: number; live: number }>(
        `select count(*)::int as total,
                count(*) filter (where enabled)::int as live
           from mcp_servers`,
      );
      const [mcpTools] = await db.query<{ live: number }>(
        `select count(*)::int as live
           from mcp_server_tools t join mcp_servers s on s.id = t.server_id
          where t.state = 'approved' and t.available and s.enabled`,
      );

      // Installed skills, as COUNTS and nothing else. How many are installed,
      // how many are actually switched on, and how many packages were refused —
      // enough for a supporter to answer "is a skill making Josi behave like
      // this?" without ever being shown a line of what one says. Never a name,
      // never a publisher, never a word of the instructions: those are this
      // installation's own runbooks and a bundle goes to a third party's ticket
      // system.
      const [skills] = await db.query<{ total: number; live: number; review: number }>(
        `select count(*)::int as total,
                count(*) filter (where state = 'enabled')::int as live,
                count(*) filter (where state = 'review')::int as review
           from skills`,
      );
      const [skillQuarantine] = await db.query<{ total: number }>(
        `select count(*)::int as total from skill_quarantine`,
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
          // WHETHER, never which. A boolean answers "could this installation
          // have called an outside API?" without naming one.
          custom_apis: (customApis?.live ?? 0) > 0,
          // WHETHER, never which, for the same reason.
          mcp_servers: (mcp?.live ?? 0) > 0,
          // WHETHER any installed instructions are in front of the assistant.
          // The single most useful bit in this object when a reply reads oddly,
          // and it names nothing.
          skills: (skills?.live ?? 0) > 0,
        },
        migrations: [],
        logs: [],
        counts: {
          users, threads, documents,
          custom_apis: customApis?.total ?? 0,
          custom_apis_enabled: customApis?.live ?? 0,
          custom_api_actions_enabled: customApiActions?.live ?? 0,
          mcp_servers: mcp?.total ?? 0,
          mcp_servers_enabled: mcp?.live ?? 0,
          mcp_tools_approved: mcpTools?.live ?? 0,
          skills_installed: skills?.total ?? 0,
          skills_enabled: skills?.live ?? 0,
          skills_awaiting_review: skills?.review ?? 0,
          skills_quarantined: skillQuarantine?.total ?? 0,
        },
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

  r.get('/admin/backup-destinations', requireSuperAdmin, handle(async (_req, res) => {
    const destinations = await db.query(
      `select id,name,kind,repository,secret_ref,enabled,created_at,updated_at
         from backup_destinations order by lower(name)`,
    );
    const schedules = await db.query(
      `select id,destination_id,cadence,hour_utc,weekday,keep_daily,keep_weekly,
              keep_monthly,enabled,last_enqueued_at,next_run_at
         from backup_schedules order by next_run_at`,
    );
    const runs = await db.query(
      `select id,destination_id,backup_id,operation,state,snapshot_id,error_category,
              started_at,finished_at from backup_agent_runs order by started_at desc limit 50`,
    );
    return res.json({ destinations, schedules, runs, secretRoot: '/run/josi-backup-secrets' });
  }));

  r.post('/admin/backup-destinations', requireSuperAdmin, handle(async (req, res) => {
    const kind = str(req.body?.kind, 16) as DestinationKind;
    if (!['local', 'nas', 's3', 'r2', 'b2'].includes(kind)) throw new RouteError(400, 'choose a supported destination type');
    const name = str(req.body?.name, 80);
    const secretRef = str(req.body?.secretRef, 80);
    if (!name) throw new RouteError(400, 'name the destination');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(secretRef)) throw new RouteError(400, 'use a safe secret reference');
    const repository = validateRepository(kind, str(req.body?.repository, 2048));
    const [destination] = await db.query(
      `insert into backup_destinations (name,kind,repository,secret_ref,created_by)
       values ($1,$2,$3,$4,$5) returning id,name,kind,repository,secret_ref,enabled`,
      [name, kind, repository, secretRef, req.user!.id],
    );
    return res.status(201).json({ destination });
  }));

  r.delete('/admin/backup-destinations/:id', requireSuperAdmin, handle(async (req, res) => {
    const [row] = await db.query<{ id: string }>(
      `delete from backup_destinations where id=$1 and not exists
       (select 1 from backup_agent_runs where destination_id=$1) returning id`, [param(req, 'id')],
    );
    if (!row) throw new RouteError(409, 'a destination with backup history cannot be deleted; disable it instead');
    return res.json({ deleted: true });
  }));

  r.put('/admin/backup-destinations/:id/schedule', requireSuperAdmin, handle(async (req, res) => {
    const cadence = req.body?.cadence === 'weekly' ? 'weekly' : 'daily';
    const hourUtc = Number(req.body?.hourUtc);
    const weekday = cadence === 'weekly' ? Number(req.body?.weekday) : null;
    const keepDaily = Number(req.body?.keepDaily ?? 7);
    const keepWeekly = Number(req.body?.keepWeekly ?? 4);
    const keepMonthly = Number(req.body?.keepMonthly ?? 6);
    if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) throw new RouteError(400, 'hourUtc must be 0 through 23');
    if (weekday !== null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new RouteError(400, 'weekday must be 0 through 6');
    if (![keepDaily, keepWeekly, keepMonthly].every(Number.isInteger)) throw new RouteError(400, 'retention values must be whole numbers');
    const destinationId = param(req, 'id');
    const [exists] = await db.query<{ id: string }>(`select id from backup_destinations where id=$1`, [destinationId]);
    if (!exists) throw new RouteError(404, 'no such backup destination');
    const [schedule] = await db.query(
      `insert into backup_schedules
         (destination_id,cadence,hour_utc,weekday,keep_daily,keep_weekly,keep_monthly,created_by,next_run_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (destination_id) do update set cadence=excluded.cadence,hour_utc=excluded.hour_utc,
         weekday=excluded.weekday,keep_daily=excluded.keep_daily,keep_weekly=excluded.keep_weekly,
         keep_monthly=excluded.keep_monthly,enabled=true,next_run_at=excluded.next_run_at
       returning *`,
      [destinationId, cadence, hourUtc, weekday, keepDaily, keepWeekly, keepMonthly, req.user!.id,
        nextRun(cadence, hourUtc, weekday)],
    );
    return res.json({ schedule });
  }));

  r.post('/admin/backups/:id/replicate', requireSuperAdmin, handle(async (req, res) => {
    if (!(await limited(req, res, LIMITS.backup))) return undefined;
    const [backup] = await db.query<{ id: string; stored_path: string; state: string }>(
      `select id,stored_path,state from backups where id=$1`, [param(req, 'id')],
    );
    if (!backup || backup.state !== 'complete') throw new RouteError(404, 'no such completed backup');
    const [destination] = await db.query<BackupDestination>(
      `select id,name,kind,repository,secret_ref,enabled from backup_destinations where id=$1`,
      [str(req.body?.destinationId, 64)],
    );
    if (!destination) throw new RouteError(404, 'no such backup destination');
    const [schedule] = await db.query<{ keep_daily:number; keep_weekly:number; keep_monthly:number }>(
      `select keep_daily,keep_weekly,keep_monthly from backup_schedules where destination_id=$1`, [destination.id],
    );
    const out = await runBackupAgent(db, { destination, backupId: backup.id, archivePath: backup.stored_path,
      actorUserId: req.user!.id, retention: { keepDaily: schedule?.keep_daily ?? 7,
        keepWeekly: schedule?.keep_weekly ?? 4, keepMonthly: schedule?.keep_monthly ?? 6 },
      runner: ctx.resticRunner, secretRoot: ctx.resticSecretRoot });
    return res.json(out);
  }));

  r.post('/admin/backups/:id/verify-offsite', requireSuperAdmin, handle(async (req, res) => {
    const [backup] = await db.query<{ id:string; stored_path:string; sha256:string|null; state:string }>(
      `select id,stored_path,sha256,state from backups where id=$1`, [param(req, 'id')],
    );
    if (!backup || backup.state !== 'complete' || !backup.sha256) throw new RouteError(404, 'no such completed backup');
    const [destination] = await db.query<BackupDestination>(
      `select id,name,kind,repository,secret_ref,enabled from backup_destinations where id=$1`, [str(req.body?.destinationId, 64)],
    );
    if (!destination) throw new RouteError(404, 'no such backup destination');
    return res.json(await verifyResticSnapshot(db, { destination, backupId:backup.id, archivePath:backup.stored_path,
      expectedSha256:backup.sha256, actorUserId:req.user!.id, runner:ctx.resticRunner, secretRoot:ctx.resticSecretRoot }));
  }));

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
