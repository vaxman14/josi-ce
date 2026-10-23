// Settings changes by talking to Josi.
//
// The model never changes a setting. It looks up the catalogue below, writes
// the exact request a screen would have sent, and records it as a proposal.
// The person makes it live from the app: their own client performs the
// request with their own session, so every route's own checks (role, password
// step-up, ownership) still run, and the proposal is the receipt either way.
import { json, type Db } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';

export interface SettingsArea {
  area: string;
  title: string;
  /** Who this changes: the proposer's own settings, or the installation. */
  scope: 'personal' | 'administrator';
  /** A change the super-admin is told about by email when a member makes it. */
  sensitive: boolean;
  method: 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  /** Path under /api, with {param} placeholders filled from `params`. */
  path: string;
  params?: string[];
  /** For the model: what the body carries, in plain words. */
  fields: string;
}

/** The catalogue is the allowlist: a proposal must name one of these areas,
 * and the request is rebuilt from the entry, never taken from the model. */
export const SETTINGS_AREAS: readonly SettingsArea[] = [
  // ---- personal: changes only the person's own settings
  { area: 'approval_level', title: 'How much Josi may do without asking me', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/assistant/approval-levels/{actionClass}', params: ['actionClass'],
    fields: 'params.actionClass: email_send, calendar_write, contact_write or task_write. body.level: "always_ask", "risky_only" or "automatic".' },
  { area: 'memory_learning', title: 'How Josi learns new memories', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/persona/settings',
    fields: 'body.memoryMode: "manual" (review suggestions), "automatic" (remember conversation facts) or "off".' },
  { area: 'personality_profile', title: 'My assistant profile (soul, about me, working style)', scope: 'personal', sensitive: false,
    method: 'PUT', path: '/persona/profiles/{kind}', params: ['kind'],
    fields: 'params.kind: soul, user or agents_user. body.content: the full new text of that profile file.' },
  { area: 'connection_capability', title: 'What a connected account may be used for', scope: 'personal', sensitive: true,
    method: 'PUT', path: '/connections/{id}/capabilities/{capability}', params: ['id', 'capability'],
    fields: 'params.id: the connection id from get_provider_status. params.capability: for example mail.read, mail.send, calendar.read, calendar.write, contacts.read, drive.read. body.enabled: true or false.' },
  { area: 'disconnect_account', title: 'Disconnect one of my accounts', scope: 'personal', sensitive: true,
    method: 'DELETE', path: '/connections/{id}', params: ['id'],
    fields: 'params.id: the connection id from get_provider_status. No body.' },
  // ---- administrator: changes the installation; the super-admin decides
  { area: 'workspace', title: 'Workspace name and time zone', scope: 'administrator', sensitive: false,
    method: 'PATCH', path: '/admin/workspace',
    fields: 'body.name: the workspace name. body.timezone: an IANA zone such as America/Los_Angeles. Send both.' },
  { area: 'approval_policy_ceiling', title: 'The loosest approval level anyone may choose', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/assistant/approval-policy/{actionClass}', params: ['actionClass'],
    fields: 'params.actionClass: the class key, for example email_send. body.maxLevel: "always_ask", "risky_only" or "automatic". body.confirmRelaxation: true when loosening.' },
  { area: 'model_spending_caps', title: 'Monthly model spending caps', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/caps',
    fields: 'body.monthlyCostUsd: a positive number or null for no cap. body.monthlyTokens: a positive whole number or null.' },
  { area: 'member_model_caps', title: 'One person\'s monthly model allowance', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/caps/users/{userId}', params: ['userId'],
    fields: 'params.userId: the person\'s user id. body.monthlyCostUsd and body.monthlyTokens as for model_spending_caps.' },
  { area: 'local_only_models', title: 'Local-only mode for models', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/llm/local-only',
    fields: 'body.enabled: true stops every request to external model providers.' },
  { area: 'pc_control_enabled', title: 'Allow Josi to control this PC', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/enabled',
    fields: 'body.enabled: true or false.' },
  { area: 'pc_control_full_control', title: 'Full control on this PC', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/full-control',
    fields: 'body.enabled: true or false. Turning it on asks the person for their password when they approve.' },
  { area: 'pc_control_scope', title: 'An exact PC Control permission', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/pc-control/policies',
    fields: 'body.action: for example browser.view, browser.fill, browser.submit, folder.read. body.scope: for a browser {kind:"browser", target:"https://site", application:"C:\\\\...\\\\chrome.exe", profile:"Default"}; for a folder {kind:"folder", target:"C:\\\\Folder"}. body.mode: never, ask, task, temporary or always. body.expiresAt for temporary.' },
  { area: 'member_connector_permission', title: 'Whether members may use a connector capability', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/connections/policy/{capability}', params: ['capability'],
    fields: 'params.capability: the capability key. body.allowed: true or false. body.note: optional reason shown to members.' },
  { area: 'developer_service_access', title: 'Who may connect a developer service', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/admin/developer-services/{service}', params: ['service'],
    fields: 'params.service: github, gitlab, vercel, netlify and so on. body.mode: not_allowed, everyone or specific_users. body.userIds: list for specific_users. body.note: optional.' },
  { area: 'storage_policy', title: 'Storage limits and file types', scope: 'administrator', sensitive: true,
    method: 'PUT', path: '/storage/admin/policy',
    fields: 'The storage policy fields as shown under Storage: maximum file size, storage per person, files per person, allowed file types, archive settings. Send only the fields to change.' },
  { area: 'member_account', title: 'A member\'s role or status', scope: 'administrator', sensitive: true,
    method: 'PATCH', path: '/admin/users/{userId}', params: ['userId'],
    fields: 'params.userId: the person\'s user id. body.status: active or disabled; body.role: member or super_admin; body.displayName.' },
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
  + 'The change takes effect only after they approve it in the Josi app, so tell them it is waiting for their approval (or the administrator\'s) and never say it is done. '
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

export async function executeSettingsChangeTool(db: Db, userId: string, name: string, input: Record<string, unknown>, threadId: string | null = null) {
  if (name === 'list_josi_settings') {
    return { settings: SETTINGS_AREAS.map(({ area, title, scope, sensitive, params, fields }) => ({ area, title, scope, sensitive, params: params ?? [], fields })),
      note: 'Personal settings change only the person asking. Administrator settings wait for the super-admin. Every change is approved in the Josi app before it applies.' };
  }
  if (name !== 'propose_josi_setting_change') return { ok: false, code: 'unknown_tool' };
  const area = AREAS.get(String(input.area ?? ''));
  if (!area) return { ok: false, code: 'unknown_area', message: 'Choose an area from list_josi_settings.' };
  const summary = String(input.summary ?? '').trim();
  if (summary.length < 8 || summary.length > 600) return { ok: false, code: 'summary_required', message: 'Write one or two plain sentences saying what will change.' };
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {};
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
  if ('password' in body) return { ok: false, code: 'no_passwords', message: 'Never include a password. The person confirms it themselves when they approve.' };
  const encoded = JSON.stringify(body);
  if (encoded.length > 8192) return { ok: false, code: 'body_too_large', message: 'Keep the change under 8 KB.' };
  let path: string;
  try { path = buildPath(area, params); } catch (error) { return { ok: false, code: 'bad_params', message: (error as Error).message }; }
  const [row] = await db.query<{ id: string }>(
    `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    // json(), not the encoded text: a text parameter cast to jsonb lands as a
    // JSON string scalar, and the app would send it on double-encoded.
    [userId, area.scope, area.area, area.sensitive, area.title, summary, area.method, path, json(body), threadId]);
  return { ok: true, proposalId: row.id, scope: area.scope, state: 'proposed',
    message: area.scope === 'administrator'
      ? 'Prepared. It waits for the super-admin\'s approval under Approvals in the Josi app; nothing has changed yet.'
      : 'Prepared. It waits for the person\'s approval under Approvals in the Josi app (a popup also asks them); nothing has changed yet.' };
}
