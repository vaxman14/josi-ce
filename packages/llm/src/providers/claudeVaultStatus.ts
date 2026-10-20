import { type ClaudeCredentialStore } from '@josi-ce/core';
import { DEFAULT_CLAUDE_COMMAND } from './claudeCli.js';
import { vaultCodexExecutableAvailable } from './codexVaultRuntime.js';

/** Stored-token metadata only. Opening settings does not launch a CLI, read a
 * personal login, contact Anthropic or imply that a token has authenticated. */
export async function vaultClaudeLoginStatus(store: ClaudeCredentialStore, command = DEFAULT_CLAUDE_COMMAND) {
  const installed = await vaultCodexExecutableAvailable(command);
  const saved = await store.inspect();
  const signedIn = saved.state === 'ready' || saved.state === 'leased'
    && saved.operation !== 'login' && !saved.expiredLease;
  const detail = !installed ? 'The bundled Claude Code CLI is unavailable.'
    : saved.state === 'leased' ? saved.expiredLease
      ? 'A previous subscription run needs reconciliation before this token can be reused.'
      : 'The Vault subscription token is in use.'
    : saved.state === 'ready' ? 'Subscription token saved in the Vault. Test the model to check it with Anthropic.'
    : saved.state === 'reconnect_required' ? 'Reconnect this subscription with a new setup token.'
    : 'Save a Claude subscription setup token in the Vault to connect.';
  return { installed, signedIn, authMethod: 'vault_setup_token', connectionMethod: 'vault_setup_token',
    detail, busy: saved.state === 'leased', credential: saved };
}
