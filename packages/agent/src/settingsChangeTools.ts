// Settings changes by talking to Josi.
//
// The model never changes a setting. It looks up the catalogue below, writes
// the exact request a screen would have sent, and records it as a proposal.
// The person makes it live from the app: their own client performs the
// request with their own session, so every route's own checks (role, password
// step-up, ownership) still run, and the proposal is the receipt either way.
import { json, PcControlError, type Db, type MasterKey } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';
import { PC_SETTING_AREAS, preparePcPermissionChange } from './pcPermissionSettings.js';

export interface SettingsArea {
  area: string;
  title: string;
  /** Who this changes: the proposer's own settings, or the installation. */
  scope: 'personal' | 'administrator';
  /** Approving it takes the approver's password, checked by the server. A member
   * applying one is also reported to the super-admin by email. */
  sensitive: boolean;
  method: 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  /** Path under /api, with {param} placeholders filled from `params`. */
  path: string;
  params?: string[];
  /** The only body fields this area may carry. Without this a harmless-looking
   * area could smuggle a sensitive field past the password. */
  keys?: string[];
  /** For the model: what the body carries, in plain words. */
  fields: string;
}

/** Never in the catalogue. Credentials must not pass through a model, and Cardinal
 * Rules, the Vault and device approval have their own protected human approval. */
export const NEVER_BY_ASKING: readonly string[] = ['/vault', '/admin/vault', '/admin/automation', '/auth', '/setup', '/admin/licence', '/admin/mail/smtp', '/admin/connectors/clients'];

const SECRET_KEY = /pass(word|phrase|code)|secret|api[_-]?key|credential|private[_-]?key|recovery|token$/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|xox[abp]-|AIza)[A-Za-z0-9_-]{8,}/;
/** The first field, at any depth, that looks like it carries a secret. */
export function findSecret(value: unknown, path = 'body'): string | null {
  if (typeof value === 'string') return SECRET_VALUE.test(value.trim()) ? path : null;
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) return `${path}.${key}`;
    const found = findSecret(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/** The catalogue is the allowlist: a proposal must name one of these areas,
 * and the request is rebuilt from the entry, never taken from the model. */
export const SETTINGS_AREAS: readonly SettingsArea[] = [
  // ---- personal: changes only the person's own settings
  { area: 'approval_level', title: 'How much Josi may do without asking me', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/assistant/approval-levels/{actionClass}', params: ['actionClass'], keys: ['level'],
    fields: 'params.actionClass: email_send, calendar_write, contacts_write or task_management. body.level: "always_ask", "risky_only" or "automatic".' },
  { area: 'memory_learning', title: 'How Josi learns new memories', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/persona/settings', keys: ['memoryMode'],
    fields: 'body.memoryMode: "manual" (review suggestions), "automatic" (remember conversation facts) or "off".' },
  { area: 'personality_profile', title: 'My assistant profile (soul, about me, working style)', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/persona/profiles/{kind}', params: ['kind'], keys: ['content'],
    fields: 'params.kind: soul, user or agents_user. body.content: the full new text of that profile file.' },
  { area: 'connection_capability', title: 'What a connected account may be used for', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/connections/{id}/capabilities/{capability}', params: ['id', 'capability'], keys: ['enabled'],
    fields: 'params.id: the connection id from get_provider_status. params.capability: for example mail.read, mail.send, calendar.read, calendar.write, contacts.read, drive.read. body.enabled: true or false.' },
  { area: 'disconnect_account', title: 'Disconnect one of my accounts', scope: 'personal', sensitive: true,
    method: 'DELETE', path: '/connections/{id}', params: ['id'], keys: [],
    fields: 'params.id: the connection id from get_provider_status. No body.' },
  // ---- administrator: changes the installation; the super-admin decides
  { area: 'workspace', title: 'Workspace name and time zone', scope: 'administrator', sensitive: false,
    method: 'PATCH', path: '/admin/workspace', keys: ['name', 'timezone'],
    fields: 'body.name: the workspace name. body.timezone: an IANA zone such as America/Los_Angeles. Send both.' },
  { area: 'approval_policy_ceiling', title: 'The loosest approval level anyone may choose', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/assistant/approval-policy/{actionClass}', params: ['actionClass'], keys: ['maxLevel', 'confirmRelaxation'],
    fields: 'params.actionClass: the class key, for example email_send. body.maxLevel: "always_ask", "risky_only" or "automatic". body.confirmRelaxation: true when loosening.' },
  { area: 'model_spending_caps', title: 'Monthly model spending caps', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/caps', keys: ['monthlyCostUsd', 'monthlyTokens'],
    fields: 'body.monthlyCostUsd: a positive number or null for no cap. body.monthlyTokens: a positive whole number or null.' },
  { area: 'member_model_caps', title: 'One person\'s monthly model allowance', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/caps/users/{userId}', params: ['userId'], keys: ['monthlyCostUsd', 'monthlyTokens'],
    fields: 'params.userId: the person\'s user id. body.monthlyCostUsd and body.monthlyTokens as for model_spending_caps.' },
  { area: 'backup_schedule', title: 'When the server backs itself up', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/ops/admin/backups/schedule', keys: ['enabled', 'hour', 'keep', 'copyTo'],
    fields: 'body.enabled: true or false. body.hour: the hour of the day, 0 to 23, in the server\'s time zone. body.keep: how many backups to keep, 1 to 60. body.copyTo: a folder path to copy each backup into, or null. Send only the fields that change.' },
  { area: 'local_only_models', title: 'Local-only mode for models', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/local-only', keys: ['enabled'],
    fields: 'body.enabled: true stops every request to external model providers.' },
  { area: 'pc_control_enabled', title: 'Allow Josi to control this PC', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/enabled', keys: ['enabled'],
    fields: 'Read pc_get_permissions first. params.pcId: the selected computer id. body.enabled: true or false. This alone grants no app, file or command access.' },
  { area: 'pc_control_full_control', title: 'Full control on this PC', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/full-control', keys: ['enabled'],
    fields: 'Read pc_get_permissions first. params.pcId selects the computer. body.enabled: true or false. This is the existing everyday-control preset, not unrestricted terminal or administrator access. Approval uses a protected password popup.' },
  { area: 'pc_control_preset', title: 'Apps, terminals or full PC access', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/preset', keys: ['access','administrator','mode','expiresAt','taskId'],
    fields: 'Read pc_get_permissions first and set params.pcId. body.access: apps (all apps), terminal (all supported shells), or full (all supported operations except credentials). body.administrator: true or false; apps requires false. body.mode: always, temporary or task; expiresAt for temporary (within 24 hours), taskId for task. For once, use pc_control_decide on a waiting action. Existing exact permissions and Never/Ask rules remain. A host shell is not a filesystem or app sandbox.' },
  { area: 'pc_control_scope', title: 'A PC Control permission', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/policies', keys: ['action', 'scope', 'mode', 'expiresAt', 'taskId', 'approveRequestId'],
    fields: 'body.action: for example browser.view, browser.fill, browser.submit, folder.read. body.scope: for a browser {kind:"browser", target:"https://site", application:"C:\\\\...\\\\chrome.exe", profile:"Default"}; for a folder {kind:"folder", target:"C:\\\\Folder"}. body.mode: never, ask, task, temporary or always. body.expiresAt for temporary.' },
  { area: 'pc_control_revoke', title: 'Revoke a saved PC permission', scope: 'administrator', sensitive: true,
    method: 'DELETE', path: '/admin/pc-control/policies/{id}', params: ['id'], keys: [],
    fields: 'Read pc_get_permissions first. params.pcId selects the computer; params.id is one of its saved permission ids. No body.' },
  { area: 'pc_control_decide', title: 'Allow one exact PC action', scope: 'administrator', sensitive: true,
    method: 'POST', path: '/admin/pc-control/requests/{id}/decision', params: ['id'], keys: ['approve'],
    fields: 'Read pc_get_permissions first. params.pcId selects the computer; params.id is a pending request id. body.approve: true allows that exact immutable operation once, false denies it. Nothing is saved for future work.' },
  { area: 'member_connector_permission', title: 'Whether members may use a connector capability', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/connectors/policy/{capability}', params: ['capability'], keys: ['allowed', 'note'],
    fields: 'params.capability: the capability key. body.allowed: true or false. body.note: optional reason shown to members.' },
  { area: 'developer_service_access', title: 'Who may connect a developer service', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/developer-services/{service}', params: ['service'], keys: ['mode', 'userIds', 'note'],
    fields: 'params.service: github, gitlab, vercel, netlify and so on. body.mode: not_allowed, everyone or specific_users. body.userIds: list for specific_users. body.note: optional.' },
  { area: 'storage_policy', title: 'Storage limits and file types', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/storage/admin/policy',
    fields: 'The storage policy fields as shown under Storage: maximum file size, storage per person, files per person, allowed file types, archive settings. Send only the fields to change.' },
  { area: 'member_account', title: 'A member\'s role or status', scope: 'administrator', sensitive: true,
    method: 'PATCH', path: '/admin/users/{userId}', params: ['userId'], keys: ['status', 'role', 'displayName'],
    fields: 'params.userId: the person\'s user id. body.status: active or disabled; body.role: member or super_admin; body.displayName.' },
  { area: 'live_signin_grant', title: 'Whether someone may sign in for Josi', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/live-signin/grants/{userId}', params: ['userId'], keys: ['granted'],
    fields: 'params.userId: the person user id. body.granted: true lets that person see the whole of Josi browser and open her login terminal to sign in for her (it can show the owner logins too); false takes it away. Off for everyone but the owner by default.' },
  // ---- personal, added with the settings pages
  { area: 'show_narration', title: 'Whether Josi narrates what she is doing', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/persona/settings', keys: ['showNarration'],
    fields: 'body.showNarration: true or false.' },
  { area: 'calendar_source', title: 'Which of my calendars Josi uses', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/calendar/sources/{id}', params: ['id'], keys: ['selected', 'writeDefault'],
    fields: 'params.id: the calendar source id. body.selected: true or false. body.writeDefault: true makes it the calendar new events go to.' },
  { area: 'contact_sync_mode', title: 'How one account syncs my contacts', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/contacts/sync/{connectionId}', params: ['connectionId'], keys: ['mode'],
    fields: 'params.connectionId: the connection id from get_provider_status. body.mode: the sync mode shown under Contacts.' },
  { area: 'contact_sync_interval', title: 'How often my contacts sync', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/contacts/sync/{originId}/interval', params: ['originId'], keys: ['seconds'],
    fields: 'params.originId: the contact source id. body.seconds: the interval in seconds.' },
  { area: 'folder_indexing', title: 'Whether Josi indexes a connected folder', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/storage/mappings/{id}/indexing', params: ['id'], keys: ['enabled'],
    fields: 'params.id: the mapping id from list_workspace_mappings. body.enabled: true or false.' },
  { area: 'folder_permissions', title: 'What Josi may do in a connected folder', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/storage/mappings/{id}/permissions', params: ['id'], keys: ['create', 'edit', 'move', 'delete'],
    fields: 'params.id: the mapping id from list_workspace_mappings. body.create, body.edit, body.move, body.delete: true or false.' },
  { area: 'parental_controls', title: 'A child\'s schedule and daily limit', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/parental/children/{childUserId}/controls', params: ['childUserId'], keys: ['timezone', 'dailyLimitMinutes', 'scheduleEnabled', 'windows'],
    fields: 'params.childUserId: the child\'s user id. body.timezone, body.dailyLimitMinutes (a number or null), body.scheduleEnabled, body.windows as shown under Family. Send only the fields that change.' },
  // ---- administrator, added with the settings pages
  { area: 'model_provider', title: 'Which model Josi uses', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/providers/{role}', params: ['role'], keys: ['provider', 'model', 'baseUrl', 'externalAcknowledged'],
    fields: 'params.role: primary or fallback. body.provider and body.model. body.baseUrl for a self-hosted provider. body.externalAcknowledged: true when the person has agreed to an external provider. An API key is never part of this: the person adds it under Model.' },
  { area: 'remove_fallback_model', title: 'Remove the fallback model', scope: 'administrator', sensitive: true,
    method: 'DELETE', path: '/admin/llm/providers/fallback', keys: [],
    fields: 'No body.' },
  { area: 'network_address', title: 'The address this server is reached at', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/network', keys: ['publicUrl'],
    fields: 'body.publicUrl: https://name-or-ip:port, or http://localhost:port for this PC only.' },
  { area: 'telemetry', title: 'Anonymous telemetry', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/ops/admin/telemetry', keys: ['enabled', 'endpoint'],
    fields: 'body.enabled: true or false. body.endpoint: optional address to send to.' },
  { area: 'member_storage_access', title: 'What one person may connect and index', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/storage/admin/capabilities/{userId}', params: ['userId'], keys: ['mayMapLocal', 'mayMapCloud', 'mayIndex', 'maxFiles', 'maxBytes'],
    fields: 'params.userId: the person\'s user id. body.mayMapLocal, body.mayMapCloud, body.mayIndex: true or false. body.maxFiles, body.maxBytes: whole numbers.' },
  { area: 'member_coding_access', title: 'Whether one person may run coding work', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/workspace/admin/coding/{userId}', params: ['userId'], keys: ['enabled'],
    fields: 'params.userId: the person\'s user id. body.enabled: true or false.' },
  { area: 'messaging_channel', title: 'Turn a messaging app on or off', scope: 'administrator', sensitive: true,
    method: 'POST', path: '/admin/channels/{provider}/enabled', params: ['provider'], keys: ['enabled'],
    fields: 'params.provider: whatsapp or slack. body.enabled: true or false. Telegram has its own area.' },
  { area: 'telegram_channel', title: 'Turn Telegram on or off', scope: 'administrator', sensitive: true,
    method: 'POST', path: '/admin/telegram/enabled', keys: ['enabled'],
    fields: 'body.enabled: true or false.' },
  { area: 'custom_api_enable', title: 'Switch on a custom API', scope: 'administrator', sensitive: true,
    method: 'POST', path: '/admin/custom-apis/{id}/enable', params: ['id'], keys: [],
    fields: 'params.id: the connection id. No body.' },
  { area: 'custom_api_disable', title: 'Switch off a custom API', scope: 'administrator', sensitive: true,
    method: 'POST', path: '/admin/custom-apis/{id}/disable', params: ['id'], keys: [],
    fields: 'params.id: the connection id. No body.' },
  { area: 'member_settings_policy', title: 'Whether members\' changes wait for the super-admin', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/settings-changes/policy', keys: ['memberSettingsChanges'],
    fields: 'body.memberSettingsChanges: "self" or "super_admin".' },
  { area: 'chat_reasoning', title: 'How hard Josi thinks on ordinary chat', scope: 'administrator', sensitive: false,
    method: 'PUT', path: '/settings-changes/reasoning', keys: ['chatReasoning'],
    fields: 'body.chatReasoning: "light" (quick replies, the default) or "model_default" (the model own level: slower, a little more careful on every reply). Long multi-step jobs always use the model own level.' },
];
const AREAS = new Map(SETTINGS_AREAS.map((a) => [a.area, a]));

export const SETTINGS_CHANGE_TOOLS: ToolSpec[] = [
  { def: { name: 'list_josi_settings',
    description: 'List the Josi settings that can be changed by asking. Each entry says whether it is the person\'s own setting or an administrator setting, and what the change body carries. Use it before propose_josi_setting_change.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }, actionClass: null },
  { def: { name: 'propose_josi_setting_change',
    description: 'Prepare a change to one Josi setting for the person to approve in the Josi app. Nothing changes until they approve it there, so say that it is waiting for their approval and never that it is done. An administrator setting waits for the super-admin.',
    parameters: { type: 'object', properties: {
      area: { type: 'string', maxLength: 64, description: 'An area from list_josi_settings.' },
      summary: { type: 'string', maxLength: 600, description: 'One or two plain sentences saying exactly what will change, as the person will read it before approving.' },
      params: { type: 'object', additionalProperties: { type: 'string', maxLength: 200 }, description: 'Path parameters the area needs.' },
      body: { type: 'object', additionalProperties: true, description: 'The change body for the area.' },
    }, required: ['area', 'summary'], additionalProperties: false } }, actionClass: null },
];
export const SETTINGS_CHANGE_TOOL_NAMES = new Set(SETTINGS_CHANGE_TOOLS.map((t) => t.def.name));
export const SETTINGS_CHANGE_PROMPT = 'When the person asks to change a Josi setting (approvals, permissions, PC control, models, workspace, accounts), look it up with list_josi_settings and prepare it with propose_josi_setting_change. '
  + 'For PC control, read pc_get_permissions first, name the selected computer, and pass params.pcId. If several computers are listed and the person has not identified one, ask which. The server generates the exact permission summary; never claim an unimplemented restriction or choose a different device. Use pc_control_preset for all apps, all terminals, or full access, with explicit administrator choice and task/timed/saved duration. Use pc_control_decide for once. For pc_control_scope use body.action and body.scope from the actual catalog, mode never/ask/task/temporary/always, expiresAt for temporary, taskId for task, and optional approveRequestId to save a grant and approve its matching pending action atomically. An explicit target "*" grants all targets; browser/command scopes can also use application "*", and browser profile "*", when target is "*". A command working folder is not a sandbox. '
  + 'The change takes effect only after they approve it in the Josi app, so tell them it is waiting for their approval (or the administrator\'s) and never say it is done. '
  + 'A sensitive change asks for secure owner approval. PC permission cards on the web support a passkey or protected password form. Never ask for credentials in chat. '
  + 'Passwords, API keys, tokens and client secrets are never typed in chat and never part of a proposal: open a credential card with request_credential_card instead. Two-factor sign-in, Cardinal Rules, the Vault and device approvals have their own protected steps in the app. '
  + 'Preparing a setting change is one quick step: never turn it into a work goal and never use own_goal, checkpoint_goal or revise_goal_plan for it. Call list_josi_settings, then propose_josi_setting_change, then answer in one short sentence. '
  + 'Once the person approves, the app applies it and a note saying so is added to this conversation; if asked later what changed, rely on those notes, not on an earlier "waiting" message.';

/** Fills the path template from the model's params; a missing or malformed
 * parameter refuses the proposal rather than guessing a path. */
export function buildPath(area: SettingsArea, params: Record<string, unknown>): string {
  let path = area.path;
  for (const name of area.params ?? []) {
    const value = params[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error(`params.${name} is required and must be a plain identifier`);
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  return path;
}

export async function executeSettingsChangeTool(db: Db, userId: string, name: string, input: Record<string, unknown>, threadId: string | null = null, key: MasterKey | null = null) {
  if (name === 'list_josi_settings') {
    return { settings: SETTINGS_AREAS.map(({ area, title, scope, sensitive, params, fields }) => ({ area, title, scope, sensitive, params: params ?? [], fields })),
      note: 'Personal settings change only the person asking. Administrator settings wait for the super-admin. Every change is approved in the Josi app before it applies.' };
  }
  if (name !== 'propose_josi_setting_change') return { ok: false, code: 'unknown_tool' };
  const area = AREAS.get(String(input.area ?? ''));
  if (!area) return { ok: false, code: 'unknown_area', message: 'Choose an area from list_josi_settings.' };
  let summary = String(input.summary ?? '').trim();
  if (summary.length < 8 || summary.length > 600) return { ok: false, code: 'summary_required', message: 'Write one or two plain sentences saying what will change.' };
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {};
  let body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
  const secret = findSecret(body);
  if (secret) return { ok: false, code: 'no_secrets', message: `Never include a password, key or token (${secret}). The person enters those themselves.` };
  const extra = area.keys ? Object.keys(body).filter((key) => !area.keys!.includes(key)) : [];
  if (extra.length) return { ok: false, code: 'unsupported_field', message: `This area cannot change ${extra.join(', ')}.` };
  const encoded = JSON.stringify(body);
  if (encoded.length > 8192) return { ok: false, code: 'body_too_large', message: 'Keep the change under 8 KB.' };
  let path: string;
  try { path = buildPath(area, params); } catch (error) { return { ok: false, code: 'bad_params', message: (error as Error).message }; }
  if (PC_SETTING_AREAS.has(area.area)) {
    if (!key) return { ok: false, code: 'pc_permissions_unavailable', message: 'Encrypted PC permission storage is unavailable.' };
    try { ({path,body,summary}=await preparePcPermissionChange(db,userId,key,area.area,body,params,path)); }
    catch (error) { return { ok: false, code: 'invalid_pc_permission', message: error instanceof PcControlError ? error.message : 'PC permissions could not be read. Nothing changed.' }; }
  }
  const sensitive=area.sensitive&&!(PC_SETTING_AREAS.has(area.area)&&(area.area==='pc_control_revoke'||body.enabled===false||body.approve===false||body.mode==='never'||body.mode==='ask'));
  const [row] = await db.query<{ id: string }>(
    `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    // json(), not the encoded text: a text parameter cast to jsonb lands as a
    // JSON string scalar, and the app would send it on double-encoded.
    [userId, area.scope, area.area, sensitive, area.title, summary, area.method, path, json(body), threadId]);
  return { ok: true, proposalId: row.id, scope: area.scope, state: 'proposed',
    message: area.scope === 'administrator'
      ? `Prepared. It waits for the super-admin\'s approval under Approvals in the Josi app${area.sensitive ? ', with their password' : ''}; nothing has changed yet.`
      : `Prepared. It waits for the person\'s approval under Approvals in the Josi app (a popup also asks them${area.sensitive ? ', with their password' : ''}); nothing has changed yet.` };
}
