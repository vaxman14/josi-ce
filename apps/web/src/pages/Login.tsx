import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Button, Card, ErrorNote, Input } from '@/components/ui';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(identifier, password);
      navigate('/app', { replace: true });
    } catch (err) {
      // The server answers identically for an unknown account and a wrong
      // password, so this cannot enumerate accounts either.
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full min-w-0 max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/brand/josi-wordmark.png" alt="Josi" width={200} height={97}
               className="mb-2 h-auto w-40 max-w-full" />
          <p className="text-sm text-muted-foreground">Your assistant, on your own server.</p>
        </div>
        <Card>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm" htmlFor="identifier">Username or email</label>
              <Input id="identifier" name="identifier" autoComplete="username" autoCapitalize="none"
                     value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-sm" htmlFor="password">Password</label>
              <Input id="password" name="password" type="password" autoComplete="current-password"
                     value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </Card>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Josi CE 0.1 — Community Preview. Created and published by SOCAL RECEPTIONIST LLC.
        </p>
      </div>
    </div>
  );
}
