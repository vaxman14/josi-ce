import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button, ErrorNote, Input } from '@/components/ui';
import { AuthPanel, AuthStage } from '@/components/auth/AuthStage';

export function SetPassword() {
  const [params] = useSearchParams(); const navigate = useNavigate(); const token = params.get('token') ?? '';
  const [password, setPassword] = useState(''); const [show, setShow] = useState(false);
  const [label, setLabel] = useState('Checking link…'); const [error, setError] = useState('');
  useEffect(() => { if (!token) return setError('That reset link is missing its token.');
    void api.get<{ username: string; email: string }>(`/auth/token/${encodeURIComponent(token)}`)
      .then((r) => setLabel(`Set a password for ${r.username} (${r.email})`)).catch((e) => setError(e instanceof Error ? e.message : 'That link is not valid'));
  }, [token]);
  async function submit(event: React.FormEvent) { event.preventDefault(); setError('');
    try { await api.post('/auth/set-password', { token, password }); navigate('/app', { replace: true }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not set password'); }
  }
  return <AuthStage><AuthPanel>
    <h1 className="text-[1.45rem] font-bold leading-tight tracking-tight">Choose a new password</h1>
    <p className="mb-5 mt-1 break-words text-sm text-lilac">{label}</p>
    <form onSubmit={submit} className="space-y-3"><div className="flex gap-2">
      <label className="sr-only" htmlFor="new-password">New password</label>
      <Input id="new-password" type={show ? 'text' : 'password'} minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <Button type="button" variant="secondary" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</Button>
    </div><p className="text-xs text-text-muted">At least 12 characters.</p>{error ? <ErrorNote>{error}</ErrorNote> : null}
    <Button className="min-h-12 w-full rounded-[0.9rem]">Set password</Button></form>
  </AuthPanel></AuthStage>;
}
