import { appendEvent, isVaultCredentialReference, openCredentialPayload, storeVaultCredentialPayload, VaultError, type Db, type MasterKey } from '@josi-ce/core';
import { requireConnectorVault } from './credentialVault.js';
import type { WorkflowIntegration } from './workflows.js';

export interface WorkflowCredentials { token: string; workspaceId?: string; workspaceType?: 'team' | 'organization' }
export function withWorkflowTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Workflow credentials require transactions');
  return db.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext('josi_workflow_credentials'))");
    await tx.query('select id from vault_state where id=true for share');
    return work(tx);
  });
}
export function sameWorkflowCredentials(current: WorkflowIntegration, observed: WorkflowIntegration): boolean {
  return ['id', 'created_by', 'provider', 'base_url', 'credentials_enc', 'callback_secret_enc', 'allow_private_network']
    .every(field => current[field as keyof WorkflowIntegration] === observed[field as keyof WorkflowIntegration]);
}
/** Internal helper for reconnect: replacing a broken provider token must not
 * require opening that old token in order to preserve its callback verifier. */
export async function openWorkflowCallback(tx: Db, key: MasterKey, row: WorkflowIntegration): Promise<string> {
  await requireConnectorVault(tx);
  const payload = await openCredentialPayload<{ secret: unknown }>(tx, key, {
    ownerUserId: row.created_by, service: `workflow.${row.provider}`, slot: `${row.id}.callback`, stored: row.callback_secret_enc,
  });
  if (typeof payload.secret !== 'string' || !payload.secret) throw new VaultError('The workflow callback credential is invalid');
  return payload.secret;
}
export async function prepareWorkflowCredentials(db: Db, key: MasterKey, observed: WorkflowIntegration) {
  return withWorkflowTransaction(db, async tx => {
    await requireConnectorVault(tx);
    const [row] = await tx.query<WorkflowIntegration>('select * from workflow_integrations where id=$1 for update', [observed.id]);
    if (!row || row.status === 'disconnected' || !row.credentials_enc || !row.callback_secret_enc || !sameWorkflowCredentials(row, observed))
      throw new VaultError('The workflow connection changed or was disconnected. Load the current connection again.');
    const credentials = await openCredentialPayload<WorkflowCredentials>(tx, key, {
      ownerUserId: row.created_by, service: `workflow.${row.provider}`, slot: row.id, stored: row.credentials_enc,
    });
    if (typeof credentials.token !== 'string' || !credentials.token
      || (credentials.workspaceId !== undefined && typeof credentials.workspaceId !== 'string')
      || (credentials.workspaceType !== undefined && !['team', 'organization'].includes(credentials.workspaceType)))
      throw new VaultError('The workflow provider credential is invalid');
    const callbackSecret = await openWorkflowCallback(tx, key, row);
    if (!isVaultCredentialReference(row.credentials_enc) || !isVaultCredentialReference(row.callback_secret_enc)) {
      row.credentials_enc = await storeVaultCredentialPayload(tx, key, { ownerUserId: row.created_by, kind: 'api_key', service: `workflow.${row.provider}`,
        slot: row.id, label: row.name, payload: { ...credentials } });
      row.callback_secret_enc = await storeVaultCredentialPayload(tx, key, { ownerUserId: row.created_by, kind: 'api_key', service: `workflow.${row.provider}`,
        slot: `${row.id}.callback`, label: `${row.name} callback`, payload: { secret: callbackSecret } });
      await tx.query('update workflow_integrations set credentials_enc=$2,callback_secret_enc=$3 where id=$1', [row.id, row.credentials_enc, row.callback_secret_enc]);
      await appendEvent(tx, { actorUserId: row.created_by, actor: 'system', kind: 'workflow.credentials_migrated', subjectType: 'workflow_integration', subjectId: row.id });
    }
    return { integration: row, credentials, callbackSecret };
  });
}
