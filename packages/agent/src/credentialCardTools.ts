// Credential cards: the one way a secret reaches Josi's Vault from a chat.
//
// docs/JOSI_IS_THE_INTERFACE.md rules 3 and 5. The model asks for a card by
// kind and provider; the server builds the card from the catalogue below (the
// fields, the route, the fixed values) and records it as a settings-change
// proposal with area `credential_card`. The app renders it: the person pastes
// into secure fields, the app performs the route with the person's own
// session, and reports the outcome. The model receives only "card opened" and,
// later, the note the route's outcome writes into the thread. No value typed
// into a card is ever returned to a conversation, a log or a proposal row.
import { json, type Db } from '@josi-ce/core';
import { OAUTH_PROVIDERS, DEVELOPER_SERVICE_CATALOG, isDeveloperService, mayConnect, clientStatuses, sharedGoogleAvailable, type OAuthProvider, type DeveloperService } from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';
import { connectorRequirement, installationOrigin } from './setupStatusTools.js';

export type CardFieldType = 'text' | 'secret' | 'confirm';
export interface CardField { key: string; label: string; type: CardFieldType; help?: string; required?: boolean; placeholder?: string }
export interface CredentialCard {
  kind: CredentialKind | typeof ACCOUNT_CONNECTION_KIND;
  provider: string;
  title: string;
  /** What the person is doing, in the words they are held to. */
  intro: string;
  fields: CardField[];
  /** Where the value comes from, so a card is never a dead end. */
  help: { text: string; url: string | null };
  /** Shown to the person once the route accepted the card. */
  done: string;
}
export const CREDENTIAL_KINDS = ['oauth_client', 'developer_token', 'nextcloud_account', 'model_api_key', 'mail_server', 'telegram_bot', 'messaging_channel'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export const CREDENTIAL_CARD_AREA = 'credential_card';
/** A card with nothing to type: one button that opens the provider's own
 * sign-in page in the person's browser. The app starts the handshake with the
 * person's session and reports the outcome when the browser returns. */
export const ACCOUNT_CONNECTION_KIND = 'account_connection';

const PROVIDER_NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', dropbox: 'Dropbox', box: 'Box', nextcloud: 'Nextcloud', whatsapp: 'WhatsApp', slack: 'Slack', primary: 'primary model', fallback: 'fallback model' };
export function providerName(provider: string): string { return PROVIDER_NAMES[provider] ?? DEVELOPER_SERVICE_CATALOG.find((d) => d.service === provider)?.label ?? provider; }

interface Prepared { scope: 'personal' | 'administrator'; method: 'PUT' | 'POST'; path: string; fixed: Record<string, unknown>; card: CredentialCard }

/** Builds a card from the catalogue. Throws a plain message when the kind or
 * provider is not one the catalogue knows. The model's input chooses the
 * entry; nothing else of the model's reaches the card. */
export async function prepareCredentialCard(db: Db, kind: CredentialKind, provider: string): Promise<Prepared> {
  const origin = (await installationOrigin(db)).origin;
  switch (kind) {
    case 'oauth_client': {
      if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`oauth_client needs one of ${OAUTH_PROVIDERS.join(', ')}.`);
      const requirement = connectorRequirement(provider as OAuthProvider, origin);
      const name = providerName(provider);
      const secretLabel = provider === 'dropbox' ? 'App secret' : 'Client secret';
      const idLabel = provider === 'dropbox' ? 'App key' : provider === 'microsoft' ? 'Application (client) ID' : 'Client ID';
      return { scope: 'administrator', method: 'PUT', path: `/admin/connectors/clients/${provider}`, fixed: { redirectUri: requirement.redirectUris[0] },
        card: { kind, provider, title: `${name} application`, intro: `Paste the ${idLabel.toLowerCase()} and ${secretLabel.toLowerCase()} of the ${name} application registered for this Josi. Redirect URI${requirement.redirectUris.length > 1 ? 's' : ''} to register there: ${requirement.redirectUris.join(' and ')}.`,
          fields: [{ key: 'clientId', label: idLabel, type: 'text', required: true }, { key: 'clientSecret', label: secretLabel, type: 'secret', required: true }],
          help: { text: requirement.steps, url: requirement.console }, done: `${name} is ready. Anyone on this Josi can now connect their ${name} account by asking.` } };
    }
    case 'developer_token': {
      if (!isDeveloperService(provider)) throw new Error('developer_token needs a service from josi_setup_status, for example github.');
      const d = DEVELOPER_SERVICE_CATALOG.find((x) => x.service === provider)!;
      const fields: CardField[] = [];
      if (d.baseUrlLabel) fields.push({ key: 'baseUrl', label: d.baseUrlLabel, type: 'text', required: true, placeholder: 'https://' });
      if (d.usernameLabel) fields.push({ key: 'username', label: d.usernameLabel, type: 'text', required: true });
      if (d.emailLabel) fields.push({ key: 'email', label: d.emailLabel, type: 'text', required: true });
      fields.push({ key: 'token', label: d.tokenLabel, type: 'secret', required: true });
      return { scope: 'personal', method: 'PUT', path: `/connections/developer/${provider}`, fixed: {},
        card: { kind, provider, title: `Connect ${d.label}`, intro: `Paste your ${d.label} ${d.tokenLabel.toLowerCase()}. Josi checks it with ${d.label} and keeps it in the Vault; it never appears in chat. ${d.capability}`,
          fields, help: { text: d.tokenHelp, url: d.tokenUrl }, done: `${d.label} is connected.` } };
    }
    case 'nextcloud_account':
      return { scope: 'personal', method: 'POST', path: '/connections/nextcloud/connect', fixed: {},
        card: { kind, provider: 'nextcloud', title: 'Connect Nextcloud', intro: 'Your Nextcloud server, your username and an app password made for Josi.',
          fields: [{ key: 'serverUrl', label: 'Server address', type: 'text', required: true, placeholder: 'https://cloud.example.com' }, { key: 'username', label: 'Username', type: 'text', required: true }, { key: 'appPassword', label: 'App password', type: 'secret', required: true }],
          help: { text: 'In Nextcloud open Settings → Security → Devices & sessions and create a new app password named Josi.', url: null }, done: 'Nextcloud is connected.' } };
    case 'model_api_key': {
      if (provider !== 'primary' && provider !== 'fallback') throw new Error('model_api_key needs provider "primary" or "fallback" (the model slot).');
      const [slot] = await db.query<{ provider: string; model: string; base_url: string | null }>('select provider, model, base_url from llm_providers where role = $1', [provider]);
      if (!slot) throw new Error(`There is no ${provider} model yet. Choose one first with propose_josi_setting_change (model_provider).`);
      const keyUrl: Record<string, string | null> = { openai: 'https://platform.openai.com/api-keys', anthropic: 'https://console.anthropic.com/settings/keys', xai: 'https://console.x.ai', openai_compatible: null };
      return { scope: 'administrator', method: 'PUT', path: `/admin/llm/providers/${provider}`, fixed: { provider: slot.provider, model: slot.model, baseUrl: slot.base_url ?? '', externalAcknowledged: true },
        card: { kind, provider, title: `API key for ${slot.model}`, intro: `Paste the API key for ${slot.provider} (${slot.model}). It is kept in the Vault and used only for this Josi's requests.`,
          fields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
          help: { text: 'Create a key in the provider\'s console and paste it here.', url: keyUrl[slot.provider] ?? null }, done: `The ${provider} model has its key.` } };
    }
    case 'mail_server': {
      const profiles = await db.query<{ kind: string; updated_at: string; host: string | null; port: number | null; security: string | null; username: string | null; from_name: string | null; from_address: string | null }>(
        'select kind, updated_at::text as updated_at, host, port, security, username, from_name, from_address from smtp_profiles');
      const system = profiles.find((p) => p.kind === 'system');
      const expected = { system: system?.updated_at ?? null, communications: profiles.find((p) => p.kind === 'communications')?.updated_at ?? null };
      return { scope: 'administrator', method: 'PUT', path: '/admin/mail/smtp',
        // The route wants both profiles; the card edits the system one and the
        // communications profile copies it. The app folds the typed fields in.
        fixed: { expected, __shape: 'smtp' },
        card: { kind, provider: 'smtp', title: 'Mail server', intro: 'The SMTP server Josi sends from: invitations, sign-in codes and reports. For Gmail use smtp.gmail.com, port 587, STARTTLS and a 16-letter App Password.',
          fields: [
            { key: 'host', label: 'Server', type: 'text', required: true, placeholder: system?.host ?? 'smtp.example.com' },
            { key: 'port', label: 'Port', type: 'text', required: true, placeholder: String(system?.port ?? 587) },
            { key: 'security', label: 'Security (none, starttls or tls)', type: 'text', required: true, placeholder: system?.security ?? 'starttls' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: system?.username ?? '' },
            { key: 'password', label: 'Password', type: 'secret', required: true },
            { key: 'fromName', label: 'From name', type: 'text', required: false, placeholder: system?.from_name ?? 'Josi' },
            { key: 'fromAddress', label: 'From address', type: 'text', required: true, placeholder: system?.from_address ?? '' },
          ],
          help: { text: 'Your mail provider\'s SMTP settings page has the server, port and security; Gmail needs an App Password from your Google account\'s security settings.', url: null }, done: 'The mail server is saved.' } };
    }
    case 'telegram_bot':
      return { scope: 'administrator', method: 'POST', path: '/admin/telegram/token', fixed: {},
        card: { kind, provider: 'telegram', title: 'Telegram bot', intro: 'Paste the token BotFather gave you. Josi checks it with Telegram and keeps it in the Vault.',
          fields: [{ key: 'token', label: 'Bot token', type: 'secret', required: true }],
          help: { text: 'In Telegram talk to @BotFather, send /newbot, and copy the token it answers with.', url: 'https://t.me/BotFather' }, done: 'The Telegram bot is saved; turn it on by asking Josi.' } };
    case 'messaging_channel': {
      if (provider === 'slack') return { scope: 'administrator', method: 'POST', path: '/admin/channels/slack/config', fixed: {},
        card: { kind, provider, title: 'Slack app', intro: 'The signing secret and bot token of the Slack app made for this Josi.',
          fields: [{ key: 'signingSecret', label: 'Signing secret', type: 'secret', required: true }, { key: 'botToken', label: 'Bot token (xoxb-…)', type: 'secret', required: true },
            { key: 'riskAcknowledged', label: 'I understand messages pass through Slack\'s servers', type: 'confirm', required: true }],
          help: { text: 'In api.slack.com create an app, copy the signing secret under Basic Information and the bot token under OAuth & Permissions.', url: 'https://api.slack.com/apps' }, done: 'Slack is saved; turn it on by asking Josi.' } };
      if (provider === 'whatsapp') return { scope: 'administrator', method: 'POST', path: '/admin/channels/whatsapp/config', fixed: {},
        card: { kind, provider, title: 'WhatsApp Business', intro: 'The Meta app secret, a permanent access token, the phone number ID and a webhook verify secret of your choosing.',
          fields: [{ key: 'appSecret', label: 'App secret', type: 'secret', required: true }, { key: 'accessToken', label: 'Access token', type: 'secret', required: true }, { key: 'phoneNumberId', label: 'Phone number ID', type: 'text', required: true },
            { key: 'webhookSecret', label: 'Webhook verify token', type: 'secret', required: true }, { key: 'riskAcknowledged', label: 'I understand messages pass through Meta\'s servers', type: 'confirm', required: true }],
          help: { text: 'In Meta for Developers open your app → WhatsApp → API Setup for the phone number ID and token; App settings → Basic for the app secret.', url: 'https://developers.facebook.com/apps' }, done: 'WhatsApp is saved; turn it on by asking Josi.' } };
      throw new Error('messaging_channel needs provider "slack" or "whatsapp".');
    }
    default: throw new Error(`Unknown credential kind. Choose one of ${CREDENTIAL_KINDS.join(', ')}.`);
  }
}

export const CREDENTIAL_CARD_TOOLS: ToolSpec[] = [
  { def: { name: 'request_credential_card',
    description: 'Open a secure card in the Josi app for the person to paste a credential into: an OAuth application\'s client ID and secret (Google, Microsoft, Dropbox, Box), a developer service token (GitHub, GitLab, Vercel, Netlify, Supabase and the others), a Nextcloud account, a model API key, the mail server password, a Telegram bot token, or a Slack or WhatsApp app. The value goes from the card to the Vault and never through this conversation: never ask for a credential in chat and never repeat one. Call it once the person says they have the credential (or wants to paste it now); when they do not have it yet, tell them the steps from josi_setup_status first. The result says only that the card is open; a note in this conversation later says whether it was saved.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: [...CREDENTIAL_KINDS], description: 'What kind of credential.' },
      provider: { type: 'string', maxLength: 40, description: 'For oauth_client: google, microsoft, dropbox or box. For developer_token: the service, for example github. For model_api_key: primary or fallback. For messaging_channel: slack or whatsapp. Others: omit.' },
    }, required: ['kind'], additionalProperties: false } }, actionClass: null },
];
CREDENTIAL_CARD_TOOLS.push({ def: { name: 'start_account_connection',
  description: 'Connect the person\'s own Google, Microsoft, Dropbox or Box account from this conversation: opens a card in the Josi app with one "Sign in" button that takes them to the provider\'s sign-in page in their browser. Use it whenever the person asks to connect, link, sign in to or add such an account ("connect my Gmail", "add my work calendar", "link Dropbox"). Never send them to a Connections screen. If the provider\'s application is not set up on this Josi yet, the result says so and what to do instead. The result says only that the card is open; a note in this conversation later says whether the account was connected.',
  parameters: { type: 'object', properties: {
    provider: { type: 'string', enum: [...OAUTH_PROVIDERS], description: 'Gmail, Google Calendar, Drive, Contacts: google. Outlook, OneDrive, Microsoft 365: microsoft.' },
  }, required: ['provider'], additionalProperties: false } }, actionClass: null });
export const CREDENTIAL_CARD_TOOL_NAMES = new Set(CREDENTIAL_CARD_TOOLS.map((t) => t.def.name));

export const CREDENTIAL_CARD_PROMPT = 'Setting up a connector is a conversation: "Set up Google" → say what it needs (from josi_setup_status: a client ID and secret, and the exact redirect URIs) and ask whether they have it. Yes → request_credential_card, then say the card is open and stop. No → offer the steps, with the redirect URIs quoted exactly. '
  + 'The same for GitHub and the other developer services ("got a token, or need help getting one?"), a model\'s API key, the mail server, Telegram, Slack and WhatsApp. Open one card per credential set; never ask for the value in chat and never repeat a value the person pastes anywhere by mistake. '
  + 'After the card is saved a note appears in this conversation; then offer the next natural step (connect the account, pull something from GitHub, send a test email). '
  + '"Connect my Google account" (or Gmail, Calendar, Drive, Outlook, OneDrive, Dropbox, Box) → start_account_connection: the person gets a card with one Sign in button. Say the card is open and stop; never tell them to open Connections or any other screen, and never ask for their password.';

export async function executeCredentialCardTool(db: Db, userId: string, name: string, input: Record<string, unknown>, threadId: string | null = null) {
  if (name === 'start_account_connection') return startAccountConnection(db, userId, input, threadId);
  if (name !== 'request_credential_card') return { ok: false, code: 'unknown_tool' };
  const kind = String(input.kind ?? '') as CredentialKind;
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind)) return { ok: false, code: 'unknown_kind', message: `Choose one of ${CREDENTIAL_KINDS.join(', ')}.` };
  const provider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  if (provider && !/^[a-z0-9_-]{1,40}$/.test(provider)) return { ok: false, code: 'bad_provider', message: 'The provider must be a plain name such as google or github.' };
  const [user] = await db.query<{ role: string }>('select role from users where id = $1', [userId]);
  const admin = user?.role === 'super_admin';
  let prepared: Prepared;
  try { prepared = await prepareCredentialCard(db, kind, provider || (kind === 'nextcloud_account' ? 'nextcloud' : kind === 'mail_server' ? 'smtp' : kind === 'telegram_bot' ? 'telegram' : '')); }
  catch (error) { return { ok: false, code: 'bad_request', message: (error as Error).message }; }
  if (prepared.scope === 'administrator' && !admin) return { ok: false, code: 'administrator_only', message: 'Only the owner (administrator) can set this up. Tell the person so and offer to ask the owner for them.' };
  if (kind === 'developer_token' && !admin) {
    // Members may connect a developer service only where the owner allowed
    // it; the owner may always (rule 2). Without permission the conversation
    // continues through request_connector_access, not a card.
    const [policy] = await db.query<{ mode: string }>('select mode from developer_service_policy where service = $1', [provider]);
    const allowed = await db.query<{ user_id: string }>('select user_id from developer_service_allowed_users where service = $1', [provider]);
    if (!mayConnect({ mode: (policy?.mode ?? 'not_allowed') as 'not_allowed' | 'everyone' | 'specific_users', allowedUserIds: allowed.map((a) => a.user_id) }, userId))
      return { ok: false, code: 'needs_admin_approval', message: `The owner has not allowed ${providerName(provider as DeveloperService)} for this person yet. Ask for it with request_connector_access; the owner decides in chat, in the app or on their phone.` };
  }
  // One card per credential at a time: an earlier card for the same route
  // that was never filled in is superseded, so "open it again" never leaves
  // a trail of popups behind.
  await db.query(`update settings_change_proposals set state = 'expired' where proposer_user_id = $1 and area = $2 and path = $3 and state = 'proposed'`, [userId, CREDENTIAL_CARD_AREA, prepared.path]);
  const [row] = await db.query<{ id: string }>(
    `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id)
     values ($1, $2, $3, false, $4, $5, $6, $7, $8, $9) returning id`,
    [userId, prepared.scope, CREDENTIAL_CARD_AREA, prepared.card.title, prepared.card.intro, prepared.method, prepared.path, json({ card: prepared.card, fixed: prepared.fixed }), threadId]);
  return { ok: true, cardId: row.id, state: 'card_open',
    message: `A card titled "${prepared.card.title}" is open in the Josi app (and under Approvals) for the person to fill in: ${prepared.card.fields.map((f) => f.label).join(', ')}. Say it is open and wait; a note here will say when it is saved. Never ask for the value in chat.` };
}

async function startAccountConnection(db: Db, userId: string, input: Record<string, unknown>, threadId: string | null) {
  const provider = String(input.provider ?? '').trim().toLowerCase();
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) return { ok: false, code: 'bad_provider', message: `Choose one of ${OAUTH_PROVIDERS.join(', ')}.` };
  const name = providerName(provider);
  const [user] = await db.query<{ role: string }>('select role from users where id = $1', [userId]);
  const admin = user?.role === 'super_admin';
  const client = (await clientStatuses(db)).find((c) => c.provider === provider);
  const ready = (client?.configured ?? false) || (provider === 'google' && await sharedGoogleAvailable(db).catch(() => false));
  if (!ready) return { ok: false, code: 'application_not_set_up', message: admin
    ? `The ${name} application is not set up on this Josi yet, so nobody can sign in with ${name}. Say so in one sentence, give the needs from josi_setup_status, and offer request_credential_card with kind oauth_client.`
    : `The owner has not set up ${name} on this Josi yet. Tell the person so; only the owner can set it up.` };
  const path = `/connections/${provider}/start`;
  const card: CredentialCard = { kind: ACCOUNT_CONNECTION_KIND, provider, title: `Connect ${name}`,
    intro: `Sign in with ${name} in your browser and allow Josi. You come back here on your own when it is done. Your ${name} password is typed on ${name}'s page only; Josi never sees it.`,
    fields: [], help: { text: 'Everything the account grants starts on. Ask Josi to turn any of it off.', url: null }, done: `Your ${name} account is connected.` };
  await db.query(`update settings_change_proposals set state = 'expired' where proposer_user_id = $1 and area = $2 and path = $3 and state in ('proposed', 'approved')`, [userId, CREDENTIAL_CARD_AREA, path]);
  const [row] = await db.query<{ id: string }>(
    `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id)
     values ($1, 'personal', $2, false, $3, $4, 'POST', $5, $6, $7) returning id`,
    [userId, CREDENTIAL_CARD_AREA, card.title, card.intro, path, json({ card, fixed: { native: true } }), threadId]);
  return { ok: true, cardId: row.id, state: 'card_open',
    message: `A card titled "${card.title}" is open in the Josi app (and under Approvals) with a "Sign in with ${name}" button. Say it is open and wait; a note here will say when the account is connected. Do not describe any other screen.` };
}
