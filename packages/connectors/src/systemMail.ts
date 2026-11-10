// Josi's own email through a connected account.
//
// "System mail" is what the installation itself sends: sign-in codes, password
// resets, notices to the owner. It used to need an SMTP server. An owner who
// connected a Google or Microsoft account can choose that account instead, and
// then these few messages go out through Gmail or Microsoft Graph with the
// mail.send scope the account already granted.
//
// One account for the whole installation, chosen by the owner, stored in
// `system_mail_account`. It is separate from the per-person switch "Josi may
// send email for me": that one governs mail Josi writes on a person's behalf,
// this one governs the installation's own notices. The provider scope must
// have been granted either way.
//
// Nothing here logs a recipient, a subject, a body or a provider's own words.
import { randomUUID } from 'node:crypto';
import { appendEvent, type Db, type MasterKey } from '@josi-ce/core';
import { accessTokenFor, getConnection, type ConnectionRow } from './connections.js';
import { loadClient } from './oauthClients.js';
import { ConnectorError, type FetchOptions } from './providers.js';
import { providerRequest, raiseProviderError } from './providers/http.js';

export type MailAccountProvider = 'google' | 'microsoft';
const SEND_SCOPE: Record<MailAccountProvider, string> = {
  google: 'https://www.googleapis.com/auth/gmail.send',
  microsoft: 'Mail.Send',
};

/** The message shape the SMTP transport takes, so either can be handed to the
 * same caller. Declared here because this package does not depend on mail. */
export interface AccountMailMessage {
  from: string;
  replyTo: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  headers: Record<string, string>;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
}
export interface AccountMailTransport {
  send(message: AccountMailMessage): Promise<{ messageId: string }>;
}
export interface AccountMailSender {
  provider: MailAccountProvider;
  connectionId: string;
  /** The same two fields callers read from an SMTP profile. */
  profile: { fromName: string; fromAddress: string };
  transport: AccountMailTransport;
}

export interface SystemMailAccount {
  provider: MailAccountProvider;
  connectionId: string;
  accountEmail: string | null;
  fromName: string;
  /** False when the account was disconnected or needs reconnecting. */
  active: boolean;
  updatedAt: string;
}

/** Which account sends Josi's own email, if the owner chose one. */
export async function systemMailAccount(db: Db): Promise<SystemMailAccount | null> {
  const [row] = await db.query<{ provider: MailAccountProvider; connection_id: string; from_name: string; updated_at: string; account_email: string | null; status: string }>(
    `select a.provider, a.connection_id, a.from_name, a.updated_at::text as updated_at, c.account_email, c.status
       from system_mail_account a join connections c on c.id = a.connection_id where a.id = true`);
  if (!row) return null;
  return { provider: row.provider, connectionId: row.connection_id, accountEmail: row.account_email, fromName: row.from_name,
    active: row.status === 'active', updatedAt: row.updated_at };
}

/** True when the connection's consent covered sending mail. */
export function grantsMailSend(connection: Pick<ConnectionRow, 'provider' | 'granted_scopes'>): boolean {
  const scope = SEND_SCOPE[connection.provider as MailAccountProvider];
  if (!scope) return false;
  return connection.granted_scopes.split(/\s+/).some((granted) => granted.toLowerCase() === scope.toLowerCase());
}

export class SystemMailAccountError extends Error {}

/** The owner chooses the account. Only an owner's own active Google or
 * Microsoft connection that was granted mail sending qualifies. */
export async function setSystemMailAccount(db: Db, args: { connectionId: string; fromName?: string | null; actorUserId: string }): Promise<SystemMailAccount> {
  const connection = await getConnection(db, args.connectionId);
  if (!connection || connection.status !== 'active' || (connection.provider !== 'google' && connection.provider !== 'microsoft')) {
    throw new SystemMailAccountError('Connect a Google or Microsoft account first.');
  }
  const [owner] = await db.query<{ role: string }>(`select role from users where id = $1 and status = 'active'`, [connection.owner_user_id]);
  if (owner?.role !== 'super_admin' || connection.owner_user_id !== args.actorUserId) {
    throw new SystemMailAccountError("Josi's own email can only go out through an account the owner connected.");
  }
  if (!connection.account_email) throw new SystemMailAccountError('That account did not say what its email address is. Connect it again.');
  if (!grantsMailSend(connection)) throw new SystemMailAccountError('That account did not allow sending email. Connect it again and allow sending.');
  const fromName = (args.fromName ?? '').replace(/[\r\n"<>]/g, '').trim().slice(0, 120) || 'Josi';
  await db.query(
    `insert into system_mail_account(id, connection_id, provider, from_name, configured_by, updated_at) values(true, $1, $2, $3, $4, now())
     on conflict (id) do update set connection_id = excluded.connection_id, provider = excluded.provider, from_name = excluded.from_name,
       configured_by = excluded.configured_by, updated_at = now()`,
    [connection.id, connection.provider, fromName, args.actorUserId]);
  await appendEvent(db, { actorUserId: args.actorUserId, actor: 'user', kind: 'mail.system_account_set', payload: { provider: connection.provider } });
  return (await systemMailAccount(db))!;
}

export async function clearSystemMailAccount(db: Db, actorUserId: string | null): Promise<boolean> {
  const removed = await db.query('delete from system_mail_account where id = true returning provider');
  if (removed.length) await appendEvent(db, { actorUserId, actor: actorUserId ? 'user' : 'system', kind: 'mail.system_account_cleared', payload: {} });
  return removed.length > 0;
}

// ------------------------------------------------------------------ the message

const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const encodeWord = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
function mailbox(name: string, address: string): string {
  const safe = clean(name).replace(/["\\<>]/g, '');
  if (!safe) return address;
  return /^[\x20-\x7e]*$/.test(safe) ? `"${safe}" <${address}>` : `${encodeWord(safe)} <${address}>`;
}
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const OWN_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'reply-to', 'mime-version', 'content-type', 'content-transfer-encoding', 'message-id', 'date']);

/** A plain-text RFC 5322 message. Exported for its test. */
export function buildAccountMime(message: AccountMailMessage, sender: { fromName: string; fromAddress: string }, messageId: string): string {
  const address = (value: string) => {
    const one = clean(value);
    if (!/^[^\s<>,;"]+@[^\s<>,;"]+$/.test(one)) throw new ConnectorError('that is not an email address', { category: 'provider_error' });
    return one;
  };
  const to = message.to.map(address), cc = message.cc.map(address);
  if (!to.length) throw new ConnectorError('a recipient is required', { category: 'provider_error' });
  const lines = [
    `From: ${mailbox(sender.fromName, sender.fromAddress)}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Reply-To: ${sender.fromAddress}`,
    `Subject: ${encodeWord(clean(message.subject))}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers)
      .filter(([name]) => HEADER_NAME.test(name) && !OWN_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${encodeWord(clean(String(value)))}`),
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return lines.join('\r\n');
}

async function sendThroughAccount(provider: MailAccountProvider, accessToken: string, mime: string, opts: FetchOptions): Promise<void> {
  const result = provider === 'google'
    ? await providerRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }) }, opts)
    // Graph takes a whole MIME message as base64 text.
    : await providerRequest('https://graph.microsoft.com/v1.0/me/sendMail',
        { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
          body: Buffer.from(mime, 'utf8').toString('base64') }, opts);
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
}

/** The sender for Josi's own email when the owner chose an account, or null
 * when they did not (or the account is gone), so the caller falls back to the
 * SMTP system profile. Throws only what the Vault throws while it is locked. */
export async function accountMailSender(db: Db, key: MasterKey, opts: FetchOptions = {}): Promise<AccountMailSender | null> {
  const chosen = await systemMailAccount(db);
  if (!chosen || !chosen.active || !chosen.accountEmail) return null;
  const profile = { fromName: chosen.fromName, fromAddress: chosen.accountEmail };
  const domain = chosen.accountEmail.split('@')[1] ?? 'josi.invalid';
  return {
    provider: chosen.provider, connectionId: chosen.connectionId, profile,
    transport: {
      async send(message) {
        // Josi's own notices are text. Refusing is better than silently dropping a file.
        if (message.attachments.length) throw new ConnectorError('attachments are not sent through a connected account', { category: 'provider_error' });
        const connection = await getConnection(db, chosen.connectionId);
        if (!connection || connection.status !== 'active') throw new ConnectorError('this connection needs to be reconnected', { category: 'revoked', revoked: true });
        if (!grantsMailSend(connection)) throw new ConnectorError('this account did not allow sending email', { category: 'insufficient_scope' });
        const client = await loadClient(db, key, chosen.provider);
        const accessToken = await accessTokenFor(db, key, { connection, client }, opts);
        const messageId = `<${randomUUID()}@${domain}>`;
        await sendThroughAccount(chosen.provider, accessToken, buildAccountMime(message, profile, messageId), opts);
        return { messageId };
      },
    },
  };
}
