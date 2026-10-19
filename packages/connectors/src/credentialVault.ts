import { VaultLockedError, type Db } from '@josi-ce/core';

/** Take this before consumer rows so Vault lock/recovery and credential commits
 * have one order. The caller owns the database transaction. */
export async function requireConnectorVault(tx: Db): Promise<void> {
  const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>(
    'select initialized_at,locked from vault_state where id=true for share',
  );
  if (!state?.initialized_at || state.locked) throw new VaultLockedError('Initialize and unlock the Master Vault to use connected-account credentials.');
}
