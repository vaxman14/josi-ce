import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorNote, Input } from '@/components/ui';
import { AuthPanel, AuthStage } from '@/components/auth/AuthStage';

export function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api.post<{ message: string }>('/auth/forgot-password', { identifier });
      setMessage(result.message);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not request a reset'); }
    finally { setBusy(false); }
  }
  return <AuthStage><AuthPanel>
    <h1 className="text-[1.45rem] font-bold leading-tight tracking-tight">Reset password</h1>
    <p className="mb-5 mt-1 text-sm text-lilac">Enter your username or email.</p>
    <form onSubmit={submit} className="space-y-3">
      <label className="sr-only" htmlFor="reset-identifier">Username or email</label>
      <Input id="reset-identifier" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
      {message ? <p role="status" className="text-sm">{message}</p> : null}{error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button className="min-h-12 w-full rounded-[0.9rem]" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
      <a className="mx-auto flex min-h-11 w-fit items-center text-sm text-primary underline-offset-2 hover:underline" href="/login">Back to sign in</a>
    </form>
  </AuthPanel></AuthStage>;
}
