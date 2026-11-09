// Shared by every page. account.js imports these helpers too.
let csrf = null;

export async function api(path, body) {
  csrf ??= (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()).token;
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again in a minute.'), { code: data.code, status: res.status });
  return data;
}

export const fields = form => Object.fromEntries(new FormData(form));
export const fragment = name => new URLSearchParams(location.hash.slice(1)).get(name);

/** Runs a form's work and shows any refusal in the form's own error line. */
export function onSubmit(form, work) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const line = form.querySelector('.error'), button = form.querySelector('button:not([type=button])');
    if (line) line.textContent = '';
    if (button) button.disabled = true;
    try { await work(fields(form), event.submitter); } catch (error) { if (line) line.textContent = error.message; }
    if (button) button.disabled = false;
  });
}

const form = name => document.querySelector(`[data-form="${name}"]`);
function done(formEl, title, text) {
  formEl.hidden = true;
  document.querySelectorAll('[data-alt]').forEach(el => { el.hidden = true; });
  // The intro was for the form, and now only gets in the way of the outcome.
  document.querySelector('h1').nextElementSibling?.matches('p') && (document.querySelector('h1').nextElementSibling.hidden = true);
  const note = document.createElement('p');
  note.className = 'ok';
  note.textContent = text;
  formEl.after(note);
  document.querySelector('h1').textContent = title;
}

for (const input of document.querySelectorAll('input[type=password]')) {
  const wrap = document.createElement('span'), toggle = document.createElement('button');
  wrap.className = 'password';
  input.replaceWith(wrap);
  wrap.append(input, toggle);
  Object.assign(toggle, { type: 'button', className: 'show', textContent: 'Show' });
  toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-label', 'Show password');
  toggle.addEventListener('click', () => {
    const shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    toggle.textContent = shown ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(shown));
    input.focus();
  });
}

const signup = form('signup');
if (signup) {
  const preview = signup.querySelector('[data-preview]');
  signup.elements.handle.addEventListener('input', event => { preview.textContent = `${event.target.value || 'yourname'}.heyjosi.com`; });
  onSubmit(signup, async values => { await api('/signup', values); done(signup, 'Check your email', 'We sent you a link to confirm your account. It works for 48 hours.'); });
}

const googleName = form('google-name');
if (googleName) {
  const preview = googleName.querySelector('[data-preview]');
  googleName.elements.handle.addEventListener('input', event => { preview.textContent = `${event.target.value || 'yourname'}.heyjosi.com`; });
  onSubmit(googleName, async values => { await api('/signup/google', values); location.assign('/account'); });
}

const login = form('login');
if (login) {
  // Back from Google with two-step sign-in on: only the code is left to ask for.
  if (location.hash === '#2fa') {
    login.hidden = true;
    document.querySelector('[data-alt]').hidden = true;
    form('second-step').hidden = false;
    form('second-step').elements.code.focus();
  }
  const resend = login.querySelector('[data-resend]');
  onSubmit(login, async values => {
    resend.hidden = true;
    try {
      const { mfa } = await api('/login', values);
      if (mfa) { login.hidden = true; form('second-step').hidden = false; form('second-step').elements.code.focus(); } else location.assign('/account');
    } catch (error) { if (error.code === 'unverified') resend.hidden = false; throw error; }
  });
  resend.addEventListener('click', async () => { await api('/resend-verification', { email: login.elements.email.value }); resend.hidden = true; login.querySelector('.error').textContent = 'Sent. Check your email.'; });
  onSubmit(form('second-step'), async values => { await api('/login/2fa', values); location.assign('/account'); });
}

const forgot = form('forgot');
if (forgot) onSubmit(forgot, async values => { await api('/forgot', values); done(forgot, 'Check your email', 'If that email has an account, a reset link is on its way.'); });

const reset = form('reset');
if (reset) onSubmit(reset, async values => { await api('/reset', { token: fragment('token'), password: values.password }); location.assign('/login'); });

const verify = document.querySelector('[data-page="verify"]');
if (verify) {
  const status = verify.querySelector('[data-status]');
  api('/verify-email', { token: fragment('token') }).then(() => { status.textContent = 'Your email is confirmed. You can log in now.'; }, error => { status.textContent = error.message; });
}

const join = document.querySelector('[data-join]');
if (join) join.addEventListener('click', async () => {
  const line = document.querySelector('.error');
  line.textContent = '';
  try { await api('/household/accept', { token: fragment('token') }); location.assign('/account'); } catch (error) { line.textContent = error.message; }
});
