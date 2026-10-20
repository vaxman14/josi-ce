import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorNote } from '@/components/ui';
import type { ClaudeCliStatus } from './ClaudeSignIn';

export function ClaudeVaultSignIn({ basePath, status, onStatus }: {
  basePath: string; status: ClaudeCliStatus; onStatus: (value: ClaudeCliStatus) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expected = status.credential
    ? { itemId: status.credential.itemId, revision: status.credential.revision } : null;
  async function act(action: 'connect' | 'logout' | 'status') {
    const submitted = token.trim();
    setToken(''); setBusy(true); setError('');
    try {
      if (action === 'connect') {
        const saved = await api.post<{ cli: ClaudeCliStatus }>(`${basePath}/connect`, { token: submitted, expected });
        onStatus(saved.cli);
      } else {
        if (action === 'logout') await api.post(`${basePath}/logout`, { expected });
        onStatus((await api.get<{ cli: ClaudeCliStatus }>(`${basePath}/status`)).cli);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The subscription change could not be confirmed. Refresh status.');
    } finally { setBusy(false); }
  }
  return <div className="space-y-3 rounded-md border border-input p-3">
    <p className="text-sm font-medium">{status.signedIn ? 'Claude token saved in the Vault' : 'Connect Claude through the Vault'}</p>
    <p className="text-xs text-muted-foreground">{status.detail}</p>
    <p className="text-sm">
      Run <code>claude setup-token</code> using Anthropic’s official CLI, complete its sign-in,
      then paste the resulting subscription token here. An API key or one-time sign-in code will not work.
      {' '}<a href="https://code.claude.com/docs/en/authentication#generate-a-long-lived-token"
        target="_blank" rel="noreferrer" className="underline">Anthropic’s instructions</a>
    </p>
    <label className="block text-sm">
      Subscription setup token
      <input type="password" value={token} onChange={e => setToken(e.target.value)}
        autoComplete="off" spellCheck={false} maxLength={16384} disabled={busy || status.busy}
        className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm" />
    </label>
    <p className="text-xs text-muted-foreground">
      Josi saves this secret only in the server’s Vault. Saving does not verify the account:
      use Test Model to confirm it works. Everyone using this installation shares its subscription limits.
      Expired tokens must be replaced.
    </p>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={busy || status.busy || !status.installed || !expected || token.trim().length < 16}
        onClick={() => void act('connect')}>{status.signedIn ? 'Replace saved token' : 'Save token in Vault'}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void act('status')}>Refresh status</Button>
      {status.signedIn ? <Button type="button" variant="secondary" disabled={busy || status.busy}
        onClick={() => void act('logout')}>Disconnect Claude</Button> : null}
    </div>
  </div>;
}
