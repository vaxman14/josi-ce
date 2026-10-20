import { CodexCredentialStore, SubscriptionCredentialError,
  type SubscriptionCredentialAdministration, type SubscriptionCredentialStatus } from '@josi-ce/core';
import { parseDeviceChallenge, parseExpiry, type LoginSnapshot } from './codexLogin.js';
import { DEFAULT_CODEX_COMMAND } from './codexCli.js';
import { startVaultCodex, vaultCodexExecutableAvailable, type VaultCodexRun } from './codexVaultRuntime.js';

/** Status is about the saved subscription login, not a fresh network probe.
 * Inspecting settings never launches a CLI or refreshes a token. */
export async function vaultCodexLoginStatus(store: CodexCredentialStore, command = DEFAULT_CODEX_COMMAND) {
  const installed = await vaultCodexExecutableAvailable(command);
  const saved = await store.inspect();
  const signedIn = saved.state === 'ready' || saved.state === 'leased'
    && saved.operation !== 'login' && !saved.expiredLease;
  const detail = !installed ? 'The bundled Codex CLI is unavailable.'
    : saved.state === 'leased' ? saved.expiredLease
      ? 'A previous subscription run needs reconciliation. Its older login will not be reused.'
      : saved.operation === 'login' ? 'Subscription sign-in is in progress.' : 'The saved subscription login is in use.'
    : saved.state === 'ready' ? 'Subscription login saved in the Vault. Testing a model checks it with the provider.'
    : saved.state === 'reconnect_required' ? 'Reconnect this subscription in Josi’s model settings.'
    : 'No ChatGPT subscription login is saved in the Vault. Sign in through Josi.';
  return { installed, signedIn, detail, busy: saved.state === 'leased', credential: saved };
}

/** One in-memory UI projection of the exclusive canonical login claim.
 * It never reports signed_in until the supervised CLI has closed and its
 * resulting auth cache has committed to the exact Vault item. */
export class VaultDeviceLogin {
  private run: VaultCodexRun | undefined;
  private snapshot: LoginSnapshot = { state: 'starting', challenge: null, expiresAt: null, message: null };
  private buffer = '';
  private inFlight = false;
  constructor(private store: CodexCredentialStore, private command = DEFAULT_CODEX_COMMAND) {}
  get status(): LoginSnapshot { return { ...this.snapshot }; }
  get running(): boolean { return this.inFlight; }
  async start(expected: Pick<SubscriptionCredentialStatus, 'itemId' | 'revision'>,
    authority: SubscriptionCredentialAdministration, requireCurrentAuthority?: () => Promise<void>): Promise<LoginSnapshot> {
    if (this.inFlight) return this.status;
    this.inFlight = true;
    try {
      this.run = await startVaultCodex(this.store, {
        operation: 'login', command: this.command, args: ['login', '--device-auth'], timeoutMs: 15 * 60_000,
        administration: { expected, authority },
        requireCurrentAuthority,
        onLoginOutput: text => {
          this.buffer = (this.buffer + text).slice(-16_384);
          if (this.snapshot.challenge) return;
          const challenge = parseDeviceChallenge(this.buffer);
          if (!challenge) return;
          const url = new URL(challenge.verificationUrl);
          if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com'
            || url.username || url.password || url.port) return;
          const seconds = Math.min(parseExpiry(this.buffer) ?? 900, 900);
          this.snapshot = { state: 'awaiting_approval', challenge,
            expiresAt: new Date(Date.now() + seconds * 1_000).toISOString(), message: null };
          this.buffer = '';
        },
      });
      void this.run.result.then(value => {
        this.snapshot = value.cancelled
          ? { state: 'cancelled', challenge: null, expiresAt: null, message: 'Sign-in cancelled.' }
          : value.code === 0 && !value.spawnError
            ? { state: 'signed_in', challenge: null, expiresAt: null, message: 'Subscription login saved in the Vault.' }
            : { state: 'failed', challenge: null, expiresAt: null, message: 'The provider sign-in did not complete. Start again for a new code.' };
      }, () => {
        this.snapshot = { state: 'failed', challenge: null, expiresAt: null,
          message: 'The subscription login could not be saved safely. Check its status before reconnecting.' };
      }).finally(() => { this.inFlight = false; this.buffer = ''; });
      const deadline = performance.now() + 60_000;
      while (this.snapshot.state === 'starting' && this.inFlight && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.snapshot.state === 'starting') {
        await this.cancel();
        this.snapshot = { state: 'failed', challenge: null, expiresAt: null,
          message: 'The provider did not produce a sign-in code. Check the connection and try again.' };
      }
      return this.status;
    } catch (err) {
      this.inFlight = false; this.buffer = '';
      throw err;
    }
  }
  async cancel(): Promise<void> {
    if (this.run && this.inFlight) await this.run.stop();
    this.buffer = '';
  }
  /** Used only by the same server process that actually supervised this run.
   * A process restart loses this evidence; the UI cannot invent a stop proof. */
  requireStopped(leaseId: string | null): void {
    if (!leaseId || leaseId !== this.run?.leaseId || !this.run.consumerStopped()) {
      throw new SubscriptionCredentialError('The server cannot confirm that the previous subscription consumer and its private cache stopped.');
    }
  }
}
