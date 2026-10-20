import { appendEvent, deleteVaultSlot, isVaultCredentialReference, openCredentialEnvelope, openCredentialPayload, storeVaultCredentialPayload,
  unwrapSecrets, VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import type { SmtpProfile } from './smtp.js';

type Kind = 'system' | 'communications';
interface Row {
  kind: Kind; copy_from_system: boolean; host: string | null; port: number | null; security: string | null;
  username: string | null; password_enc: string | null; from_name: string | null; from_address: string | null;
  vault_owner_user_id: string | null; updated_at: string;
}
export interface SmtpProfileInput {
  copyFromSystem?: boolean; host?: string | null; port?: number | null; security?: string | null;
  username?: string | null; password?: unknown; clearPassword?: boolean; fromName: string | null; fromAddress: string;
}
export type SmtpProfileVersions = { system: string | null; communications: string | null };
function requireVersions(all: Row[], expected?: SmtpProfileVersions) {
  if (expected === undefined) return; // Existing setup callers have their own step fence.
  if (!expected || Object.keys(expected).sort().join(',') !== 'communications,system'
    || (['system', 'communications'] as const).some(kind => expected[kind] !== (all.find(row => row.kind === kind)?.updated_at ?? null))) {
    throw new SmtpConfigurationError(409, 'Email settings changed. Reload and review the current profiles before saving.');
  }
}
/** Metadata only. In particular neither credentials nor encrypted pointers
 * are returned to the settings client. Readable while the Vault is locked. */
export async function listSmtpProfiles(db: Db) {
  return transaction(db, async tx => {
    const all = await rows(tx), versions: SmtpProfileVersions = {
      system: all.find(row => row.kind === 'system')?.updated_at ?? null,
      communications: all.find(row => row.kind === 'communications')?.updated_at ?? null,
    };
    return { versions, profiles: all.map(row => ({
      kind: row.kind, copyFromSystem: row.copy_from_system, host: row.host, port: row.port, security: row.security,
      username: row.username, passwordSet: !!row.password_enc, fromName: row.from_name, fromAddress: row.from_address,
      configurationVersion: row.kind === 'system' ? row.updated_at
        : `${row.updated_at}/${row.copy_from_system ? versions.system ?? '' : row.updated_at}`,
    })) };
  });
}
export class NoProfileError extends Error {}
export class SmtpConfigurationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Mail profile operations require transactions');
  return db.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext('josi_smtp_configuration'))");
    await tx.query('select id from vault_state where id=true for share');
    return work(tx);
  });
}
async function requireVault(tx: Db, key: MasterKey | null): Promise<MasterKey> {
  const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true');
  if (!key || !state?.initialized_at || state.locked) throw new VaultLockedError('Initialize and unlock the Vault to use email credentials.');
  return key;
}
async function ownerFor(tx: Db, row: Row | undefined, key: MasterKey | null, actorUserId?: string): Promise<string> {
  if (row?.vault_owner_user_id) return row.vault_owner_user_id;
  if (row?.password_enc) {
    const envelope = await openCredentialEnvelope(tx, await requireVault(tx, key), row.password_enc);
    if (envelope.vaultItemId) {
      const [item] = await tx.query<{ owner_user_id: string; service: string; slot: string }>('select owner_user_id,service,slot from vault_items where id=$1', [envelope.vaultItemId]);
      if (!item || item.service !== 'smtp' || item.slot !== row.kind) throw new VaultError('The email credential context did not match');
      return item.owner_user_id;
    }
  }
  const [admin] = await tx.query<{ id: string }>("select id from users where role='super_admin' order by created_at limit 1");
  const owner = admin?.id ?? actorUserId;
  if (!owner) throw new VaultError('The email credential has no Vault owner');
  return owner;
}
async function rows(tx: Db): Promise<Row[]> {
  return tx.query<Row>('select *,updated_at::text as updated_at from smtp_profiles order by kind for update');
}
async function readPassword(tx: Db, key: MasterKey, row: Row, owner: string): Promise<string> {
  const payload = await openCredentialPayload<{ password: unknown }>(tx, key, { ownerUserId: owner, service: 'smtp', slot: row.kind, stored: row.password_enc! });
  if (typeof payload.password !== 'string' || !payload.password) throw new VaultError('The stored email credential is invalid');
  return payload.password;
}

/** Read the current paired configuration consistently. Borrowing a server never
 * duplicates its canonical password or changes the communications identity. */
export async function loadProfile(db: Db, key: MasterKey, kind: Kind): Promise<SmtpProfile> {
  return transaction(db, async tx => {
    const all = await rows(tx), row = all.find(row => row.kind === kind);
    if (!row) throw new NoProfileError(`no ${kind} mail profile is configured`);
    const server = row.copy_from_system ? all.find(row => row.kind === 'system') : row;
    if (!server?.host || !server.port || !row.from_address) throw new NoProfileError(`the ${kind} mail profile is incomplete`);
    let password: string | null = null, version = server.updated_at;
    if (server.password_enc) {
      const available = await requireVault(tx, key), owner = await ownerFor(tx, server, available);
      password = await readPassword(tx, available, server, owner);
      if (!isVaultCredentialReference(server.password_enc) || !server.vault_owner_user_id) {
        const reference = isVaultCredentialReference(server.password_enc) ? server.password_enc : await storeVaultCredentialPayload(tx, available, {
          ownerUserId: owner, kind: 'password', service: 'smtp', slot: server.kind, label: `${server.kind} SMTP password`, payload: { password },
        });
        const [changed] = await tx.query<{ updated_at: string }>('update smtp_profiles set password_enc=$2,vault_owner_user_id=$3 where kind=$1 returning updated_at::text as updated_at', [server.kind, reference, owner]);
        version = changed.updated_at;
        await appendEvent(tx, { actorUserId: owner, actor: 'system', kind: 'smtp.credentials_migrated', payload: { profileKind: server.kind } });
      }
    }
    return { kind, host: server.host, port: server.port, security: (server.security ?? 'starttls') as SmtpProfile['security'],
      username: server.username, password, fromName: row.from_name ?? 'Josi', fromAddress: row.from_address,
      configurationVersion: kind === 'system' ? version : `${row.updated_at}/${version}` };
  });
}

/** Both profiles and their Vault changes either commit together or stay as they
 * were. Actual test mail is sent afterward, outside the transaction. */
export async function saveSmtpProfiles(db: Db, key: MasterKey | null, args: {
  system: SmtpProfileInput; communications: SmtpProfileInput; actorUserId: string; expected?: SmtpProfileVersions;
}): Promise<void> {
  await transaction(db, async tx => {
    const all = await rows(tx);
    requireVersions(all, args.expected);
    for (const kind of ['system', 'communications'] as const) {
      const input = args[kind], old = all.find(row => row.kind === kind);
      const copy = kind === 'communications' && input.copyFromSystem === true;
      if (!input.fromAddress.includes('@')) throw new SmtpConfigurationError(400, 'A valid From address is required.');
      if (!copy && (!input.host || !Number.isInteger(input.port) || input.port! < 1 || input.port! > 65535 || !['none', 'starttls', 'tls'].includes(input.security ?? '')))
        throw new SmtpConfigurationError(400, 'Choose a valid mail server, port and connection security.');
      const owner = await ownerFor(tx, old, key, args.actorUserId);
      const raw = unwrapSecrets(input.password);
      if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new SmtpConfigurationError(400, 'The mail password must be text.');
      let supplied = typeof raw === 'string' ? raw : '';
      if (!copy && supplied && input.host?.toLowerCase() === 'smtp.gmail.com') {
        supplied = supplied.replace(/\s/g, '');
        if (supplied.length !== 16) throw new SmtpConfigurationError(400, 'Google App Passwords must contain exactly 16 letters.');
      }
      if (supplied && input.clearPassword) throw new SmtpConfigurationError(400, 'Choose either a replacement password or clear password.');
      let reference: string | null = null;
      if (!copy && !input.clearPassword) {
        if (supplied) {
          reference = await storeVaultCredentialPayload(tx, await requireVault(tx, key), { ownerUserId: owner, kind: 'password', service: 'smtp', slot: kind,
            label: `${kind} SMTP password`, payload: { password: supplied }, actorUserId: args.actorUserId });
        } else if (old?.password_enc) {
          if (old.host !== input.host || old.port !== input.port || old.security !== input.security || old.username !== (input.username || null))
            throw new SmtpConfigurationError(400, 'Enter the password again when changing the mail server or account, or explicitly clear it.');
          const available = await requireVault(tx, key), password = await readPassword(tx, available, old, owner);
          reference = isVaultCredentialReference(old.password_enc) ? old.password_enc : await storeVaultCredentialPayload(tx, available, {
            ownerUserId: owner, kind: 'password', service: 'smtp', slot: kind, label: `${kind} SMTP password`, payload: { password }, actorUserId: args.actorUserId,
          });
        }
      }
      if (!reference) await deleteVaultSlot(tx, { ownerUserId: owner, service: 'smtp', slot: kind, actorUserId: args.actorUserId });
      await tx.query(`insert into smtp_profiles(kind,copy_from_system,host,port,security,username,password_enc,from_name,from_address,vault_owner_user_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(kind) do update set copy_from_system=excluded.copy_from_system,
        host=excluded.host,port=excluded.port,security=excluded.security,username=excluded.username,password_enc=excluded.password_enc,
        from_name=excluded.from_name,from_address=excluded.from_address,vault_owner_user_id=excluded.vault_owner_user_id,verified_at=null`,
      [kind, copy, copy ? null : input.host, copy ? null : input.port, copy ? null : input.security, copy ? null : (input.username || null),
        reference, input.fromName, input.fromAddress, owner]);
    }
    await tx.query("delete from setup_verifications where item='smtp'");
    await appendEvent(tx, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'smtp.configured' });
  });
}

/** Removing the system profile also removes a communications profile that
 * borrows it, while preserving any independently configured communications. */
export async function removeSmtpProfile(db: Db, key: MasterKey | null, kind: Kind, actorUserId: string, expected?: SmtpProfileVersions): Promise<void> {
  await transaction(db, async tx => {
    const all = await rows(tx);
    requireVersions(all, expected);
    for (const row of all.filter(row => row.kind === kind || (kind === 'system' && row.copy_from_system))) {
      const owner = await ownerFor(tx, row, key, actorUserId);
      await deleteVaultSlot(tx, { ownerUserId: owner, service: 'smtp', slot: row.kind, actorUserId });
      await tx.query('delete from smtp_profiles where kind=$1', [row.kind]);
    }
    await tx.query("delete from setup_verifications where item='smtp'");
    await appendEvent(tx, { actorUserId, actor: 'super_admin', kind: 'smtp.removed', payload: { profileKind: kind } });
  });
}
