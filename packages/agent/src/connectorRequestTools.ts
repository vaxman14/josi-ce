// Members ask, the owner approves: in chat, in the app, on the phone.
//
// docs/JOSI_IS_THE_INTERFACE.md rule 4. A member's "connect my GitHub" becomes
// a request the owner decides anywhere Josi is: the app shows it as a popup
// and under Approvals, the owner's chat announces it with a decide tool, and
// the owner is emailed when a mail server exists. The decision is per person,
// per connector, standing until revoked; a request unanswered for a week
// expires and the member is told.
import { json, type Db, type MasterKey } from '@josi-ce/core';
import { accountMailSender, OAUTH_PROVIDERS, DEVELOPER_SERVICE_CATALOG, isDeveloperService, mayConnect, allowDeveloperServiceFor, revokeDeveloperServiceFor } from '@josi-ce/connectors';
import { loadProfile, smtpTransport } from '@josi-ce/mail';
import type { ToolSpec } from './tools.js';
import { providerName } from './credentialCardTools.js';

export const CONNECTOR_REQUEST_AREA = 'member_connector_request';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONNECTOR_REQUEST_TOOLS: ToolSpec[] = [
  { def: { name: 'request_connector_access',
    description: 'For a member who wants to connect a service the owner has not allowed them yet (GitHub, GitLab, Vercel, Netlify, Supabase and the other developer services): asks the owner for permission. The owner sees it in their Josi app, in their own chat and by email, and decides there. Say that you asked and that they will hear back here. For the owner this is never needed: use request_credential_card directly. Google, Microsoft, Dropbox, Box and Nextcloud need no permission to connect.',
    parameters: { type: 'object', properties: {
      connector: { type: 'string', maxLength: 40, description: 'The service, for example github.' },
      reason: { type: 'string', maxLength: 300, description: 'Why, in the person\'s own words, if they said.' },
    }, required: ['connector'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'decide_connector_request',
    description: 'Owner only: approve or deny a member\'s pending request to connect a service, by its request id (announced in this conversation). Approving lets that person connect their own account from now on; denying tells them plainly. Takes effect at once.',
    parameters: { type: 'object', properties: {
      request_id: { type: 'string', format: 'uuid', maxLength: 36 },
      approve: { type: 'boolean' },
      note: { type: 'string', maxLength: 300, description: 'A word for the member, optional.' },
    }, required: ['request_id', 'approve'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'revoke_connector_access',
    description: 'Owner only: take back a member\'s permission to connect a developer service (their existing connection stops working for new requests). Pass the member\'s user id from josi_setup_status members and the service.',
    parameters: { type: 'object', properties: {
      user_id: { type: 'string', format: 'uuid', maxLength: 36 },
      connector: { type: 'string', maxLength: 40 },
    }, required: ['user_id', 'connector'], additionalProperties: false } }, actionClass: null },
];
export const CONNECTOR_REQUEST_TOOL_NAMES = new Set(CONNECTOR_REQUEST_TOOLS.map((t) => t.def.name));

export const CONNECTOR_REQUEST_PROMPT = 'When a member asks to connect a developer service they are not yet allowed (request_credential_card answers needs_admin_approval), call request_connector_access and say: "You\'ll need the owner\'s OK; asking now." When the owner has pending requests they are listed in this conversation: the owner approves or denies by saying so, and you call decide_connector_request. Never decide for the owner, and never tell a member a request was approved before a note here says so.';

async function emailOwners(db: Db, key: MasterKey | null, subject: string, text: string): Promise<boolean> {
  if (!key) return false;
  try {
    const owners = await db.query<{ email: string }>(`select email from users where role = 'super_admin' and status = 'active' and email <> ''`);
    if (!owners.length) return false;
    const account = await accountMailSender(db, key);
    const profile = account?.profile ?? await loadProfile(db, key, 'system');
    await (account?.transport ?? smtpTransport(profile as Awaited<ReturnType<typeof loadProfile>>)).send({ from: `${profile.fromName} <${profile.fromAddress}>`, replyTo: profile.fromAddress, to: owners.map((o) => o.email), cc: [],
      subject, text, headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [] });
    return true;
  } catch { return false; }
}

/** For the owner's turn: the requests waiting on them, with the ids the
 * decide tool takes. Empty for everyone else. */
export async function announceConnectorRequests(db: Db, userId: string): Promise<string> {
  const [owner] = await db.query<{ id: string }>(`select id from users where id = $1 and role = 'super_admin' and status = 'active'`, [userId]);
  if (!owner) return '';
  const rows = await db.query<{ id: string; proposer: string; summary: string; created_at: string }>(
    `select p.id, u.username as proposer, p.summary, p.created_at::text as created_at from settings_change_proposals p join users u on u.id = p.proposer_user_id
     where p.area = $1 and p.state = 'proposed' and p.expires_at > now() order by p.created_at limit 10`, [CONNECTOR_REQUEST_AREA]);
  if (!rows.length) return '';
  return `Waiting for your decision (${rows.length}): ` + rows.map((r) => `[request_id ${r.id}] ${r.summary}`).join(' | ')
    + ' Mention this briefly if it fits, and when the owner says approve or deny, call decide_connector_request with that request_id.';
}

export async function executeConnectorRequestTool(db: Db, userId: string, name: string, input: Record<string, unknown>, threadId: string | null = null, key: MasterKey | null = null) {
  const [user] = await db.query<{ role: string; username: string }>('select role, username from users where id = $1', [userId]);
  const owner = user?.role === 'super_admin';
  if (name === 'request_connector_access') {
    const connector = String(input.connector ?? '').trim().toLowerCase();
    if ((OAUTH_PROVIDERS as readonly string[]).includes(connector) || connector === 'nextcloud') {
      return { ok: true, approvalNeeded: false, message: `${providerName(connector)} needs no permission: anyone on this Josi may connect their own account. ${connector === 'nextcloud' ? 'Open the card with request_credential_card (nextcloud_account).' : 'Connecting opens the provider\'s own sign-in page: Connections → ' + providerName(connector) + ' → Connect in the Josi app.'}` };
    }
    if (!isDeveloperService(connector)) return { ok: false, code: 'unknown_connector', message: 'Name a service from josi_setup_status, for example github.' };
    const label = DEVELOPER_SERVICE_CATALOG.find((d) => d.service === connector)!.label;
    if (owner) return { ok: true, approvalNeeded: false, message: `The owner never needs permission. Open the card with request_credential_card (developer_token, ${connector}).` };
    const [policy] = await db.query<{ mode: string }>('select mode from developer_service_policy where service = $1', [connector]);
    const allowed = await db.query<{ user_id: string }>('select user_id from developer_service_allowed_users where service = $1', [connector]);
    if (mayConnect({ mode: (policy?.mode ?? 'not_allowed') as 'not_allowed' | 'everyone' | 'specific_users', allowedUserIds: allowed.map((a) => a.user_id) }, userId))
      return { ok: true, approvalNeeded: false, message: `${label} is already allowed for this person. Open the card with request_credential_card (developer_token, ${connector}).` };
    const path = `/admin/developer-services/${connector}/allow`;
    const [pending] = await db.query<{ id: string; created_at: string }>(
      `select id, created_at::text as created_at from settings_change_proposals where proposer_user_id = $1 and area = $2 and path = $3 and state = 'proposed' and expires_at > now()`, [userId, CONNECTOR_REQUEST_AREA, path]);
    if (pending) return { ok: true, approvalNeeded: true, requestId: pending.id, state: 'waiting', message: `Already asked (${pending.created_at}); the owner has not decided yet. Say so, and that they will hear back here.` };
    const reason = typeof input.reason === 'string' && input.reason.trim() ? ` Reason: ${input.reason.trim().slice(0, 300)}` : '';
    const who = user?.username ?? 'A member';
    const summary = `${who} asks to connect their own ${label} account to Josi.${reason} Approving lets ${who} paste their own token into a card; Josi uses it only for ${who}'s work, and you can take it back any time by asking.`;
    const [row] = await db.query<{ id: string }>(
      `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id, expires_at)
       values ($1, 'administrator', $2, false, $3, $4, 'POST', $5, $6, $7, now() + interval '7 days') returning id`,
      [userId, CONNECTOR_REQUEST_AREA, `${label} access for ${who}`, summary, path, json({ userId }), threadId]);
    const emailed = await emailOwners(db, key, `Josi: ${who} asks to connect ${label}`, `${summary}\n\nApprove or deny it in Josi: it is waiting in your app (a popup and under Approvals), and you can tell Josi "approve ${who}'s ${label} request" in your own chat.`);
    return { ok: true, approvalNeeded: true, requestId: row.id, state: 'waiting', ownerEmailed: emailed,
      message: `Asked. The owner sees it in their Josi app${emailed ? ' and by email' : ''} and decides there or in their chat; this conversation gets a note when they do. The request expires in a week if unanswered.` };
  }
  if (!owner) return { ok: false, code: 'owner_only', message: 'Only the owner decides this.' };
  if (name === 'decide_connector_request') {
    const id = String(input.request_id ?? '');
    if (!UUID.test(id)) return { ok: false, code: 'bad_request_id' };
    const [row] = await db.query<{ id: string; proposer_user_id: string; proposer: string; path: string; body: unknown; thread_id: string | null; state: string; title: string }>(
      `select p.id, p.proposer_user_id, u.username as proposer, p.path, p.body, p.thread_id, p.state, p.title from settings_change_proposals p join users u on u.id = p.proposer_user_id
       where p.id = $1 and p.area = $2`, [id, CONNECTOR_REQUEST_AREA]);
    if (!row) return { ok: false, code: 'not_found', message: 'No such request.' };
    if (row.state !== 'proposed') return { ok: false, code: 'already_decided', message: `That request is already ${row.state}.` };
    const service = row.path.split('/')[3] ?? '';
    const label = providerName(service);
    const note = typeof input.note === 'string' && input.note.trim() ? ` ${input.note.trim().slice(0, 300)}` : '';
    const { addMessage } = await import('@josi-ce/core');
    const tell = async (body: string) => { if (row.thread_id) { try { await addMessage(db, { threadId: row.thread_id, direction: 'out', body, meta: { settings_change: row.id } }); } catch { /* thread gone */ } } };
    if (input.approve === true) {
      const [claimed] = await db.query('update settings_change_proposals set state = \'approved\', approved_by = $2, approved_at = now() where id = $1 and state = \'proposed\' and expires_at > now() returning id', [row.id, userId]);
      if (!claimed) return { ok: false, code: 'expired', message: 'That request expired or was decided elsewhere.' };
      try {
        await allowDeveloperServiceFor(db, { service, userId: row.proposer_user_id, actorUserId: userId });
        await db.query('update settings_change_proposals set state = \'applied\', applied_by = $2, applied_at = now() where id = $1', [row.id, userId]);
      } catch (error) {
        await db.query('update settings_change_proposals set state = \'failed\', error = $2 where id = $1', [row.id, (error as Error).message.slice(0, 500)]);
        return { ok: false, code: 'failed', message: 'The permission could not be saved.' };
      }
      await tell(`Approved: the owner says you may connect ${label}.${note} Ask me to connect it and I will open the card for your token.`);
      return { ok: true, state: 'applied', message: `${row.proposer} may connect ${label} now; they have been told in their conversation.` };
    }
    await db.query('update settings_change_proposals set state = \'denied\', approved_by = $2, approved_at = now() where id = $1 and state = \'proposed\'', [row.id, userId]);
    await tell(`Not approved: the owner declined your request to connect ${label}.${note}`);
    return { ok: true, state: 'denied', message: `Declined; ${row.proposer} has been told.` };
  }
  if (name === 'revoke_connector_access') {
    const target = String(input.user_id ?? ''); const connector = String(input.connector ?? '').trim().toLowerCase();
    if (!UUID.test(target) || !isDeveloperService(connector)) return { ok: false, code: 'bad_request', message: 'Give the member\'s user id and a developer service.' };
    await revokeDeveloperServiceFor(db, { service: connector, userId: target });
    return { ok: true, message: `${providerName(connector)} is no longer allowed for that person. Their saved connection, if any, can be removed under Connections.` };
  }
  return { ok: false, code: 'unknown_tool' };
}
