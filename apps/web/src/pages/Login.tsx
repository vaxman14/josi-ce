// Signing in. One panel that changes in place: the ways in, the emailed code, the
// authenticator step, and last the J turning into a check.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, primeCsrf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canUsePasskeys, passkeyMessage, signInWithPasskey, type SignInMethods } from '@/lib/passkeys';
import { Button, ErrorNote, Input } from '@/components/ui';
import { LegalLinks } from '@/components/LegalLinks';
import { AuthPanel, AuthStage } from '@/components/auth/AuthStage';
import { CodeBoxes } from '@/components/auth/CodeBoxes';

type Step = 'start' | 'email-code' | 'mfa';

const quietLink = 'mx-auto block min-h-11 rounded-md px-2 text-sm text-primary underline-offset-2 hover:underline disabled:text-text-muted disabled:no-underline';
const wideButton = 'min-h-12 w-full rounded-[0.9rem]';
const providerButton = 'flex min-h-12 w-full items-center justify-center gap-2.5 rounded-[0.9rem] text-sm font-semibold';

function GoogleG() {
  return <svg aria-hidden viewBox="0 0 18 18" className="h-[18px] w-[18px]"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" /><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" /><path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1z" /><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" /></svg>;
}

function AppleLogo() {
  return <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor"><path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z" /></svg>;
}

export function Login() {
  const { signIn, finishMfa, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [step, setStep] = useState<Step>('start');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [success, setSuccess] = useState(false);
  const leaving = useRef(0);

  useEffect(() => {
    void api.get<SignInMethods>('/auth/methods').then(setMethods)
      .catch(() => setMethods({ passkey: false, passkeyOrigin: null, emailCode: false, appleUrl: null }));
    return () => window.clearTimeout(leaving.current);
  }, []);

  useEffect(() => {
    const reason = searchParams.get('error');
    if (!reason) return;
    setError(reason === 'google_not_linked'
      ? 'That Google account is not linked to a Josi account. Sign in with your password, then connect Google first.'
      : reason === 'google_unavailable'
        ? 'Google sign-in is not configured on this Josi installation.'
        : 'Google sign-in did not finish. Please try again.');
  }, [searchParams]);

  // A password reset or Google sign-in that still owes the authenticator. Its
  // challenge is in an httpOnly cookie the server reads, so this page has none.
  useEffect(() => {
    if (searchParams.get('mfa') === 'pending') mfaStep('');
  }, [searchParams]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(seconds => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const passkey = canUsePasskeys(methods?.passkey ? methods.passkeyOrigin : null);
  const emailCode = !!methods?.emailCode;
  // With neither of those, the password is the way in, not the quiet option.
  const showPasswordForm = passwordOpen || (!!methods && !passkey && !emailCode);

  /** The J lights up and becomes a check, then the app opens. */
  function finish() {
    setSuccess(true);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    leaving.current = window.setTimeout(() => navigate('/app', { replace: true }), still ? 500 : 1000);
  }

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try { await work(); }
    catch (err) { setError(err instanceof Error ? err.message : fallback); }
    finally { setBusy(false); }
  }

  function mfaStep(pending: string) {
    setChallenge(pending);
    setStep('mfa');
    setMfaCode('');
    setRecovery(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // The server answers identically for an unknown account and a wrong
    // password, so this cannot enumerate accounts either.
    await run(async () => {
      const pending = await signIn(identifier, password, rememberMe);
      if (pending) mfaStep(pending);
      else finish();
    }, 'Could not sign in');
  }

  async function verifyMfa(value = mfaCode) {
    await run(async () => {
      try { await finishMfa(challenge, value); finish(); }
      catch (err) { setMfaCode(''); throw err; }
    }, 'That code did not work');
  }

  async function usePasskey() {
    setBusy(true);
    setError('');
    try {
      await primeCsrf();
      await signInWithPasskey();
      await refresh();
      finish();
    } catch (err) { setError(passkeyMessage(err, 'That passkey did not work here.')); }
    finally { setBusy(false); }
  }

  async function sendCode() {
    await primeCsrf();
    const result = await api.post<{ resendAfterSeconds: number }>('/auth/email-code/request', { email: email.trim() });
    setResendIn(result.resendAfterSeconds);
  }

  async function startEmailCode(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setEmailError('Enter your email address.'); return; }
    setEmailError('');
    await run(async () => { await sendCode(); setCode(''); setStep('email-code'); }, 'Could not send a code');
  }

  async function verifyEmailCode(value = code) {
    await run(async () => {
      try {
        const result = await api.post<{ mfaRequired?: boolean; challenge?: string }>('/auth/email-code/verify', { email: email.trim(), code: value });
        if (result.mfaRequired && result.challenge) { mfaStep(result.challenge); return; }
        await refresh();
        finish();
      } catch (err) { setCode(''); throw err; }
    }, 'That code did not work');
  }

  return (
    <AuthStage success={success} footer={<>
      <p className="mt-5 max-w-[380px] text-center text-xs text-text-muted">
        Josi CE 0.1 — Community Preview. Created and published by SOCAL RECEPTIONIST LLC.
        By using this installation, you agree to its Terms and acknowledge its Privacy and Cookie Notices.
      </p>
      <LegalLinks className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-2 text-xs text-primary [&_a]:underline" />
    </>}>
      <AuthPanel>
        <div role="status" className="sr-only">{success ? 'Signed in. Opening Josi.' : ''}</div>

        {step === 'start' ? <>
          <h1 className="text-[1.45rem] font-bold leading-tight tracking-tight">Sign in to Hey Josi</h1>
          <p className="mt-1 text-sm text-lilac">Your assistant, on your own server.</p>
          {searchParams.get('setup') === 'complete' ? <p className="mt-3 text-sm">Josi setup is complete. Sign in with the owner account you created to enter Josi and choose optional connections.</p> : null}
          {error && !showPasswordForm ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}

          <div className="mt-5 space-y-3">
            {passkey ? <button type="button" disabled={busy || success} onClick={() => void usePasskey()} className={`btn-sheen ${providerButton} disabled:cursor-not-allowed disabled:opacity-60`}>Sign in with passkey</button> : null}

            {emailCode ? <>
              {passkey ? <div className="flex items-center gap-3 text-xs text-text-muted before:h-px before:flex-1 before:bg-lilac/25 after:h-px after:flex-1 after:bg-lilac/25">or use email</div> : null}
              <form onSubmit={event => void startEmailCode(event)} noValidate className="space-y-3">
                <div>
                  <label htmlFor="email" className="sr-only">Email</label>
                  <Input id="email" type="email" autoComplete="email" autoCapitalize="none" placeholder="you@email.com" value={email} aria-invalid={!!emailError} aria-describedby={emailError ? 'email-error' : undefined}
                    onChange={event => { setEmail(event.target.value); setEmailError(''); }} className="min-h-12 rounded-[0.9rem]" />
                  {emailError ? <p id="email-error" role="alert" className="mt-1.5 text-sm text-destructive">{emailError}</p> : null}
                </div>
                <Button type="submit" variant="secondary" disabled={busy || success} className={wideButton}>Email me a sign-in code</Button>
              </form>
            </> : null}

            <a href="/api/auth/google/start" className={`btn-google ${providerButton}`}><GoogleG />Continue with Google</a>
            {methods?.appleUrl ? <a href={methods.appleUrl} className={`btn-apple ${providerButton}`}><AppleLogo />Continue with Apple</a> : null}

            {methods && (passkey || emailCode) ? (
              <button type="button" aria-expanded={passwordOpen} aria-controls="password-sign-in" onClick={() => { setPasswordOpen(open => !open); setError(''); }} className={quietLink}>Use username and password</button>
            ) : null}

            {showPasswordForm ? (
              <form id="password-sign-in" onSubmit={event => void submit(event)} className="space-y-3 pt-1">
                <div>
                  <label className="mb-1 block text-sm" htmlFor="identifier">Username or email</label>
                  <Input id="identifier" name="identifier" autoComplete="username" autoCapitalize="none" value={identifier} onChange={event => setIdentifier(event.target.value)} required />
                </div>
                <div>
                  <label className="mb-1 block text-sm" htmlFor="password">Password</label>
                  <div className="flex gap-2">
                    <Input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
                    <Button type="button" variant="secondary" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</Button>
                  </div>
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} />
                  Keep me signed in on this device
                </label>
                {error ? <ErrorNote>{error}</ErrorNote> : null}
                <Button type="submit" className={wideButton} disabled={busy || success}>{busy ? 'Signing in…' : 'Sign in'}</Button>
                <a className={`${quietLink} flex w-fit items-center`} href="/forgot-password">Forgot password?</a>
              </form>
            ) : null}
          </div>
        </> : null}

        {step === 'email-code' ? <>
          <h1 className="text-[1.45rem] font-bold leading-tight tracking-tight">Check your email</h1>
          <p className="mt-1 break-words text-sm text-lilac">If {email.trim()} has an account here, a 6-digit code is on its way. It works once, for 10 minutes.</p>
          <form onSubmit={event => { event.preventDefault(); void verifyEmailCode(); }} className="mt-5 space-y-3">
            <CodeBoxes label="Sign-in code" value={code} onChange={setCode} onComplete={value => void verifyEmailCode(value)} disabled={busy || success} invalid={!!error} />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" className={wideButton} disabled={busy || success || code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
            <button type="button" disabled={busy || resendIn > 0} className={quietLink} onClick={() => void run(sendCode, 'Could not send a code')}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button>
            <button type="button" className={quietLink} onClick={() => { setStep('start'); setError(''); }}>Use a different way</button>
          </form>
        </> : null}

        {step === 'mfa' ? <>
          <h1 className="text-[1.45rem] font-bold leading-tight tracking-tight">One more step</h1>
          <p className="mt-1 text-sm text-lilac">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
          <form onSubmit={event => { event.preventDefault(); void verifyMfa(); }} className="mt-5 space-y-3">
            {recovery ? (
              <div>
                <label className="mb-1 block text-sm" htmlFor="recovery-code">Recovery code</label>
                <Input id="recovery-code" autoCapitalize="characters" autoComplete="off" value={mfaCode} onChange={event => setMfaCode(event.target.value)} required autoFocus />
              </div>
            ) : <CodeBoxes label="Authenticator code" value={mfaCode} onChange={setMfaCode} onComplete={value => void verifyMfa(value)} disabled={busy || success} invalid={!!error} />}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" className={wideButton} disabled={busy || success || !mfaCode}>{busy ? 'Signing in…' : 'Verify'}</Button>
            <button type="button" className={quietLink} onClick={() => { setRecovery(value => !value); setMfaCode(''); setError(''); }}>{recovery ? 'Use your authenticator app' : 'Use a recovery code'}</button>
            {!challenge ? <a className={`${quietLink} flex w-fit items-center`} href="/login">Start over</a> : null}
          </form>
        </> : null}
      </AuthPanel>
    </AuthStage>
  );
}
