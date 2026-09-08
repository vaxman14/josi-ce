// The administrator's launch checklist.
//
// Every fact here is read from what the installation actually contains. There
// is no "mark as done" for anything Josi can observe: the only writes this
// router accepts are the master-key backup confirmation, which Josi cannot
// observe because the file leaves the server, and a dismissal of optional work.
//
// Super-admin only, and it is mounted under `/admin`, so the existing guard
// covers it. Nothing here returns content — it returns counts and states.
import { Router } from 'express';
import {
  CHECKLIST_ITEMS, ChecklistError, buildChecklist, confirmMasterKeyBackup,
  dismissChecklistItem, getVerifications, markChecklistSeen, restoreChecklistItem,
  type ChecklistFacts, type Db,
} from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { publicHttpsBase } from '../setup/setupRoutes.js';
import { buildBestPracticeScan, type PracticeFacts } from './bestPracticeScanner.js';

export function checklistRoutes(db: Db): Router {
  const r = Router();

  async function facts(): Promise<ChecklistFacts> {
    const [state] = await db.query<{ seen_at: string | null; master_key_backup_confirmed_at: string | null }>(
      `select seen_at, master_key_backup_confirmed_at from admin_checklist_state where id = true`,
    );
    const [backups] = await db.query<{ n: string }>(`select count(*)::text as n from backups`);
    const [restores] = await db.query<{ n: string }>(
      `select count(*)::text as n from restore_attempts where state = 'complete'`,
    );
    const [users] = await db.query<{ n: string }>(`select count(*)::text as n from users`);
    const [policy] = await db.query<{ n: string }>(
      `select count(*)::text as n from events where kind in ('approval.ceiling_set', 'approval.ceiling_relaxed')`,
    );
    const [pending] = await db.query<{ n: string }>(
      `select count(*)::text as n from approval_policy_migration where acknowledged_at is null`,
    );
    const [clients] = await db.query<{ n: string }>(`select count(*)::text as n from oauth_clients`);
    const [updates] = await db.query<{ last_check_at: string | null }>(
      `select last_check_at from update_state where id = true`,
    );
    const [diagnostics] = await db.query<{ n: string }>(`select count(*)::text as n from diagnostic_bundles`);
    const [security] = await db.query<{ n: string }>(
      `select count(*)::text as n from events where kind = 'security.policy_reviewed'`,
    );
    const dismissals = await db.query<{ item: string }>(`select item from admin_checklist_dismissals`);

    const verifications = new Map(
      [...(await getVerifications(db)).entries()].map(([key, v]) => [
        key, { status: v.status, detail: v.detail },
      ]),
    );

    return {
      masterKeyBackupConfirmed: !!state?.master_key_backup_confirmed_at,
      backupCount: Number(backups?.n ?? 0),
      restoreVerified: Number(restores?.n ?? 0) > 0,
      verifications,
      userCount: Number(users?.n ?? 0),
      approvalPolicySet: Number(policy?.n ?? 0) > 0,
      unacknowledgedPolicyChanges: Number(pending?.n ?? 0),
      connectorsConfigured: Number(clients?.n ?? 0),
      connectorsUnavailableReason: (await publicHttpsBase(db))
        ? null
        : 'Google and Microsoft need a public HTTPS address. This installation is reachable only on your network.',
      securityReviewed: Number(security?.n ?? 0) > 0,
      updateChannelKnown: !!updates?.last_check_at,
      diagnosticsSeen: Number(diagnostics?.n ?? 0) > 0,
      dismissed: new Set(dismissals.map((d) => d.item)),
    };
  }

  async function seen(): Promise<boolean> {
    const [row] = await db.query<{ seen_at: string | null }>(
      `select seen_at from admin_checklist_state where id = true`,
    );
    return !!row?.seen_at;
  }

  r.get(
    '/launch-checklist',
    asyncRoute(async (_req, res) => res.json(buildChecklist(await facts(), await seen()))),
  );

  r.get(
    '/best-practices',
    asyncRoute(async (_req, res) => {
      const [state] = await db.query<{ master_key_backup_confirmed_at: string | null }>(
        `select master_key_backup_confirmed_at from admin_checklist_state where id = true`,
      );
      const counts = async (sql: string) => Number((await db.query<{ n: string }>(sql))[0]?.n ?? 0);
      const verifications = await getVerifications(db);
      const [storage] = await db.query<{
        max_file_bytes: string; max_total_bytes_per_user: string; max_files_per_user: number;
      }>(`select max_file_bytes::text, max_total_bytes_per_user::text, max_files_per_user from storage_policy where id = true`);
      const [policyChanges] = await db.query<{ n: string }>(
        `select count(*)::text as n from approval_policy_migration where acknowledged_at is null`,
      );
      const [channelHealth] = await db.query<{ enabled: string; unhealthy: string }>(
        `select sum(enabled)::text as enabled, sum(unhealthy)::text as unhealthy from (
           select count(*) filter (where enabled) as enabled,
                  count(*) filter (where enabled and probe_ok is not true) as unhealthy
             from external_channel_configs
           union all
           select count(*) filter (where enabled),
                  count(*) filter (where enabled and probe_ok is not true)
             from telegram_config
           union all
           select count(*) filter (where enabled),
                  count(*) filter (where enabled and last_check_ok is not true)
             from custom_api_connections
           union all
           select count(*) filter (where enabled),
                  count(*) filter (where enabled and last_check_ok is not true)
             from mcp_servers
           union all
           select count(*) filter (where status = 'active'),
                  count(*) filter (where status = 'active' and last_check_ok is not true)
             from developer_service_connections
         ) integration_health`,
      );
      const oauthProviders = await db.query<{ provider: string }>(
        `select provider from connector_configs where self_serve`,
      );
      const enabledOauth = oauthProviders.length;
      const unhealthyOauth = oauthProviders.filter(
        ({ provider }) => verifications.get(`connector_${provider}`)?.status !== 'passed',
      ).length;
      const facts: PracticeFacts = {
        masterKeyBackedUp: !!state?.master_key_backup_confirmed_at,
        completedBackups: await counts(`select count(*)::text as n from backups where state = 'complete' and kind = 'full'`),
        enabledBackupDestinations: await counts(`select count(*)::text as n from backup_destinations where enabled`),
        verifiedRestores: await counts(`select count(*)::text as n from restore_attempts where state = 'complete'`),
        publicHttps: !!(await publicHttpsBase(db)),
        modelVerification: verifications.get('llm')?.status ?? null,
        mailVerification: verifications.get('smtp')?.status ?? null,
        securityReviewed: await counts(`select count(*)::text as n from events where kind = 'security.policy_reviewed'`) > 0,
        approvalPolicySet: await counts(`select count(*)::text as n from events where kind in ('approval.ceiling_set', 'approval.ceiling_relaxed')`) > 0,
        unacknowledgedPolicyChanges: Number(policyChanges?.n ?? 0),
        storagePolicyPresent: !!storage,
        storageLimitsValid: !!storage && Number(storage.max_file_bytes) > 0
          && Number(storage.max_total_bytes_per_user) > 0 && storage.max_files_per_user > 0,
        enabledIntegrations: enabledOauth + Number(channelHealth?.enabled ?? 0),
        unhealthyIntegrations: unhealthyOauth + Number(channelHealth?.unhealthy ?? 0),
      };
      res.set('Cache-Control', 'no-store');
      return res.json(buildBestPracticeScan(facts));
    }),
  );

  /** Recorded when the administrator has actually looked.
   *
   * This is what stops sign-in redirecting them here forever, so it is a
   * deliberate POST rather than a side effect of the GET — a preflight, a link
   * preview or a monitoring probe must not be able to mark it seen. */
  r.post(
    '/launch-checklist/seen',
    asyncRoute(async (req, res) => {
      await markChecklistSeen(db, req.user!.id);
      return res.json({ ok: true });
    }),
  );

  r.post(
    '/launch-checklist/master-key-backed-up',
    asyncRoute(async (req, res) => {
      await confirmMasterKeyBackup(db, req.user!.id);
      return res.json({ ok: true });
    }),
  );

  r.post(
    '/launch-checklist/dismiss/:item',
    asyncRoute(async (req, res) => {
      try {
        await dismissChecklistItem(db, param(req, 'item'), req.user!.id);
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof ChecklistError) return res.status(409).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.post(
    '/launch-checklist/restore/:item',
    asyncRoute(async (req, res) => {
      const item = param(req, 'item');
      if (!CHECKLIST_ITEMS.some((i) => i.key === item)) {
        return res.status(404).json({ error: 'there is no checklist item by that name' });
      }
      await restoreChecklistItem(db, item, req.user!.id);
      return res.json({ ok: true });
    }),
  );

  return r;
}
