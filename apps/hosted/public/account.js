import { api, onSubmit } from './app.js?v=4';

const $ = selector => document.querySelector(selector);
const money = micros => `$${(micros / 1_000_000).toFixed(2)}`;
const day = text => new Date(text).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const setText = (name, value) => { for (const node of document.querySelectorAll(`[data-text="${name}"]`)) node.textContent = value; };
const showError = (name, error) => { $(`[data-error="${name}"]`).textContent = error ? error.message : ''; };

function node(tag, props = {}, ...children) {
  const made = Object.assign(document.createElement(tag), props);
  made.append(...children);
  return made;
}

function button(label, className, work, errorName) {
  const made = node('button', { type: 'button', className });
  made.textContent = label;
  made.addEventListener('click', async () => {
    showError(errorName, null);
    made.disabled = true;
    try { await work(); } catch (error) { showError(errorName, error); }
    made.disabled = false;
  });
  return made;
}

function drawPlan(account) {
  const { plan } = account;
  setText('planLabel', plan.label);
  const price = account.plans.find(option => option.id === plan.id);
  setText('planDetail', plan.id === 'free' ? '' : `$${price.monthlyUsd} a month${plan.periodEnd ? `, ${plan.cancelAtPeriodEnd ? 'ends' : 'renews'} ${day(plan.periodEnd)}` : ''}`);
  $('[data-payment]').hidden = !plan.paymentProblem;
  const box = $('[data-plans]');
  box.replaceChildren();
  for (const option of account.plans) {
    if (option.id === 'free' || option.id === plan.id) continue;
    box.append(button(`${option.label}, $${option.monthlyUsd} a month`, 'quiet', async () => location.assign((await api('/billing/checkout', { plan: option.id })).url), 'plan'));
  }
  if (plan.id !== 'free' || plan.paymentProblem) box.append(button('Manage billing', 'quiet', async () => location.assign((await api('/billing/portal', {})).url), 'plan'));
}

function drawUsage(account) {
  const { usage } = account;
  $('[data-ai]').hidden = !account.aiActive;
  if (!account.aiActive) return;
  const pool = usage.allowance + usage.topUps;
  $('[data-meter]').style.width = `${pool ? Math.min(100, Math.round(usage.spent / pool * 100)) : 0}%`;
  setText('usage', `${money(usage.remaining)} left of ${money(pool)}${usage.periodEnd ? `. Your allowance renews ${day(usage.periodEnd)}.` : '.'}`);
  const cap = usage.accountCap === null ? '' : ` Your cap is ${money(usage.accountCap)}, and you've used ${money(usage.accountSpent)} of it.`;
  const models = usage.models.map(model => model.label).join(', ');
  setText('usageDetail', `Used ${money(usage.spent)}${usage.reserved ? `, with ${money(usage.reserved)} held for calls running now` : ''}.${cap} Models: ${models}. Bigger models use it up faster.`);
  $('[data-topups]').replaceChildren(...account.topUps.map(top => node('div', { className: 'small', textContent: `Added ${money(top.amountMicros)} on ${day(top.at)}` })));
}

function drawDevices(account) {
  const box = $('[data-devices]');
  box.replaceChildren();
  if (!account.devices.length) { box.append(node('p', { className: 'small', textContent: account.server.linked ? 'No devices paired yet.' : 'Link your server to see its devices here.' })); return; }
  for (const device of account.devices) {
    const seen = device.lastSeenAt ? `last seen ${day(device.lastSeenAt)}` : 'not seen yet';
    const state = device.revokedAt ? 'Revoked' : device.revokePending ? 'Revoking when your server next connects' : seen;
    const row = node('div', { className: 'split' }, node('div', {}, node('div', { textContent: device.name }), node('div', { className: 'small', textContent: `${device.platform}, ${state}` })));
    if (!device.revokedAt && !device.revokePending) row.append(button('Revoke', 'danger', async () => { await api(`/devices/${encodeURIComponent(device.id)}/revoke`, {}); await refresh(); }, 'devices'));
    box.append(row);
  }
}

function drawHousehold(account) {
  const { household } = account;
  $('[data-household]').hidden = !household;
  if (!household) return;
  const owner = household.role === 'owner';
  $('[data-form="invite"]').hidden = !owner;
  const box = $('[data-members]');
  box.replaceChildren();
  for (const member of household.members) {
    const cap = member.capMicros === null ? 'no cap' : `cap ${money(member.capMicros)}`;
    const row = node('div', { className: 'split' }, node('div', {},
      node('div', { textContent: `${member.handle}${member.you ? ' (you)' : ''}` }),
      node('div', { className: 'small', textContent: `Used ${money(member.spentMicros)} this period, ${cap}` })));
    const actions = node('div', { className: 'row' });
    if (owner) {
      const input = node('input', { type: 'number', min: '0', step: '1', placeholder: 'Cap in $', value: member.capMicros === null ? '' : String(member.capMicros / 1_000_000) });
      input.style.width = '110px';
      input.setAttribute('aria-label', `Cap for ${member.handle}`);
      actions.append(input, button('Set cap', 'quiet', async () => { await api(`/household/members/${member.id}/cap`, { capUsd: input.value === '' ? null : Number(input.value) }); await refresh(); }, 'household'));
    }
    if (member.role !== 'owner' && (owner || member.you)) actions.append(button(member.you ? 'Leave' : 'Remove', 'danger', async () => { await api(`/household/members/${member.id}/remove`, {}); await refresh(); }, 'household'));
    row.append(actions);
    box.append(row);
  }
}

function drawTwoFactor(account) {
  const { enabled, recoveryLeft } = account.twoFactor;
  setText('twoFactor', enabled ? `It's on. You have ${recoveryLeft} recovery codes left.`
    : account.hasPassword ? 'Ask for a code from your authenticator app every time you log in.' : 'Create a password first, then you can turn this on.');
  $('[data-form="password"]').hidden = !account.hasPassword;
  $('[data-form="password-create"]').hidden = account.hasPassword;
  $('[data-form="2fa-begin"]').hidden = enabled || !account.hasPassword || !$('[data-form="2fa-enable"]').hidden;
  $('[data-form="2fa-disable"]').hidden = !enabled;
}

async function refresh() {
  const account = await api('/account');
  setText('address', account.address);
  setText('email', account.email);
  $('[data-download]').href = account.downloadUrl;
  $('[data-link-status]').textContent = account.server.linked ? `Your server is linked${account.server.version ? `, running ${account.server.version}` : ''}. Make a new code only to link a different machine.` : 'Make a code and enter it on your Josi server. It works once, for 10 minutes.';
  drawPlan(account); drawUsage(account); drawDevices(account); drawHousehold(account); drawTwoFactor(account);
}

function clicks(selector, errorName, work) {
  for (const target of document.querySelectorAll(selector)) target.addEventListener('click', async () => {
    showError(errorName, null);
    try { await work(target); } catch (error) { showError(errorName, error); }
  });
}

clicks('[data-action="logout"]', 'plan', async () => { await api('/logout', {}); location.assign('/login'); });
clicks('[data-action="link-code"]', 'link', async () => {
  const { code, expiresAt } = await api('/link-code', {});
  const box = $('[data-link-code]'), expiry = $('[data-link-expiry]');
  box.textContent = code; box.hidden = false;
  expiry.textContent = `Works once, until ${new Date(expiresAt).toLocaleTimeString()}.`; expiry.hidden = false;
});
clicks('[data-action="topup"]', 'ai', async target => location.assign((await api('/billing/topup', { usd: Number(target.dataset.usd) })).url));
clicks('[data-action="ai-reset"]', 'ai', async () => { await api('/ai-token/reset', {}); });

const twoFactorError = form => form.querySelector('.error') ?? $('[data-error="2fa"]');
function showRecovery(codes) {
  $('[data-recovery]').hidden = false;
  $('[data-recovery-codes]').replaceChildren(...codes.map(code => node('div', { textContent: code })));
}

onSubmit($('[data-form="invite"]'), async values => { showError('household', null); try { await api('/household/invite', values); $('[data-form="invite"]').reset(); } catch (error) { showError('household', error); } });
onSubmit($('[data-form="password-create"]'), async values => { await api('/password/create', values); $('[data-form="password-create"]').reset(); await refresh(); });
onSubmit($('[data-form="password"]'), async values => { await api('/password', values); $('[data-form="password"]').reset(); });
onSubmit($('[data-form="delete"]'), async values => {
  if (!confirm('Delete your account? This can\'t be undone.')) return;
  await api('/account/delete', values);
  location.assign('/signup');
});
for (const name of ['2fa-begin', '2fa-enable', '2fa-disable']) {
  const form = $(`[data-form="${name}"]`);
  onSubmit(form, async (values, submitter) => {
    showError('2fa', null);
    try {
      if (name === '2fa-begin') {
        const setup = await api('/2fa/begin', values);
        $('[data-qr]').src = setup.qr; $('[data-secret]').textContent = setup.secret;
        form.hidden = true; $('[data-form="2fa-enable"]').hidden = false;
      } else if (name === '2fa-enable') {
        showRecovery((await api('/2fa/enable', values)).recoveryCodes);
        form.hidden = true;
        await refresh();
      } else if (submitter?.dataset.submit === 'recovery-codes') {
        showRecovery((await api('/2fa/recovery-codes', values)).recoveryCodes);
        form.reset(); await refresh();
      } else { await api('/2fa/disable', values); form.reset(); await refresh(); }
    } catch (error) { twoFactorError(form).textContent = error.message; }
  });
}

refresh().catch(error => { if (error.code === 'signed_out') location.assign('/login'); else showError('plan', error); });

function showPanel() {
  const wanted = location.hash.slice(1), panels = [...document.querySelectorAll('[data-panel]')];
  const name = panels.some(panel => panel.dataset.panel === wanted) ? wanted : 'home';
  for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
  for (const link of document.querySelectorAll('[data-nav]')) link.classList.toggle('on', link.dataset.nav === name);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showPanel);
showPanel();
