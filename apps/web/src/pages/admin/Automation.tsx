import { useEffect, useState } from 'react';
import type { AutomationPolicyView, CardinalDraftView, CardinalPolicyView, CardinalRule, CardinalTestReport, ProtectedDeviceInventory } from '@josi-ce/core';
import type { PermissionScope } from '@josi-ce/protocol';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { NativeProtectedChange } from '@/components/NativeProtectedChange';
import { DeviceEnrollment } from '@/components/DeviceEnrollment';

interface Catalog { guidance: string; actions: string[]; scopeKeys: string[]; capabilities?: { permanentChanges?: boolean; deviceEnrollment?: boolean; deviceRevocation?: boolean } }
interface Settings { rules: CardinalPolicyView | null; permissions: AutomationPolicyView | null; drafts: CardinalDraftView[]; devices?: ProtectedDeviceInventory }
interface Check { report: CardinalTestReport; meaning: string | null }
interface ReviewPreview {
  inputDigest: string;
  input: { wording: string; structuredMeaning: string; guidance: string };
  reviewer: { providerId: string; model: string; configurationVersion: string; external: boolean } | null;
  canTransmit: boolean; reason: string;
}
const scopeLabels: Record<string, string> = { userId: 'People', serverId: 'Servers', deviceId: 'Devices',
  workspaceId: 'Automation workspaces', taskId: 'Original tasks' };
const fieldClass = 'mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base';
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function editable(value: unknown, catalog: Catalog): value is CardinalRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as CardinalRule;
  return Object.keys(rule).sort().join(',') === 'actions,label,onUnavailable,restriction,schemaVersion,scope,wording'
    && rule.schemaVersion === 1 && typeof rule.label === 'string' && typeof rule.wording === 'string'
    && (rule.actions === '*' || Array.isArray(rule.actions) && rule.actions.every(action => catalog.actions.includes(action)))
    && !!rule.scope && typeof rule.scope === 'object' && Object.keys(rule.scope).sort().join(',') === [...catalog.scopeKeys].sort().join(',')
    && catalog.scopeKeys.every(key => {
      const selector = rule.scope[key as keyof CardinalRule['scope']];
      return selector === '*' || !!selector && typeof selector === 'object' && Object.keys(selector).join(',') === 'ids'
        && Array.isArray(selector.ids) && selector.ids.every(id => typeof id === 'string');
    })
    && !!rule.restriction && (rule.restriction.kind === 'deny' && Object.keys(rule.restriction).join(',') === 'kind'
      || rule.restriction.kind === 'maximum_task_duration' && Object.keys(rule.restriction).sort().join(',') === 'kind,seconds'
        && Number.isSafeInteger(rule.restriction.seconds))
    && ['deny', 'pause'].includes(rule.onUnavailable);
}

export function AdminAutomation() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState(''), [tab, setTab] = useState<'rules' | 'permissions' | 'devices'>('rules');
  const [selected, setSelected] = useState<CardinalDraftView | null>(null), [editing, setEditing] = useState(false);
  async function load() {
    try {
      const value = await api.get<Settings>('/admin/automation');
      setSettings(value); setError('');
      // Refresh an unchanged draft's current Vault epoch after another
      // protected change. Never replace a newer definition or an unsaved edit.
      setSelected(current => current ? value.drafts.find(draft => draft.reference.recordId === current.reference.recordId
        && draft.reference.version === current.reference.version && draft.reference.digest === current.reference.digest) ?? current : null);
    }
    catch (cause) { setSettings(null); setError(cause instanceof Error ? cause.message : 'The Vault-backed settings could not be read.'); }
  }
  useEffect(() => {
    let alive = true;
    void api.get<Catalog>('/admin/automation/catalog').then(value => { if (alive) setCatalog(value); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Automation settings are unavailable.'); });
    void load();
    return () => { alive = false; };
  }, []);
  function choose(draft: CardinalDraftView) {
    if (!catalog || !editable(draft.document.draft, catalog)) {
      setError('This saved draft uses an unsupported structure. It remains in the Vault and has not been changed.'); return;
    }
    setSelected(draft); setEditing(true);
  }
  return <div className="mx-auto w-full max-w-4xl space-y-5">
    <div><h1 className="text-xl font-semibold">Automation and Cardinal Rules</h1>
      <p className="mt-1 text-sm text-muted-foreground">The Vault holds the authoritative rules and permissions. Only the super administrator can change them.</p></div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant={tab === 'rules' ? 'primary' : 'secondary'} onClick={() => setTab('rules')}>Cardinal Rules</Button>
      <Button variant={tab === 'permissions' ? 'primary' : 'secondary'} onClick={() => setTab('permissions')}>Automation permissions</Button>
      <Button variant={tab === 'devices' ? 'primary' : 'secondary'} onClick={() => setTab('devices')}>Protected devices</Button>
    </div>
    <Card><CardTitle>Automation is not enabled in this build</CardTitle>
      <p className="text-sm text-muted-foreground">You can prepare rule drafts, test their meaning and request advice from your selected model. Enrolled devices can review permanent rule changes in the Josi Mac app. Browser and computer control require their separate workspace connection and permissions.</p>
    </Card>
    {tab === 'rules' ? <>
      <Card><CardTitle>Every rule needs an exact meaning</CardTitle>
        <p className="text-sm text-muted-foreground">{catalog?.guidance ?? 'Specify the action, scope, restriction and what happens when facts cannot be verified.'}</p>
        <p className="mt-2 text-sm text-muted-foreground">The model advises on clarity and mismatches. It cannot approve a rule. A successful validity check does not make a rule permanent.</p>
      </Card>
      <Card><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Permanent rules</CardTitle>
        <span className="text-xs text-muted-foreground">{settings?.rules ? `Vault version ${settings.rules.reference.version}` : settings ? 'No policy saved' : 'Vault state unavailable'}</span></div>
        {settings?.rules?.reconciliationRequired || settings?.rules && !settings.rules.enforcementCurrent
          ? <ErrorNote>These rules need recovery reconciliation or revalidation before automation can continue.</ErrorNote> : null}
        <div className="space-y-3">{settings?.rules?.document.rules.map(entry => <div key={entry.ruleId} className="rounded-lg border border-border p-3">
          <p className="font-medium">{entry.definition.label}</p><p className="mt-1 whitespace-pre-wrap text-sm">{entry.definition.wording}</p>
          <p className="mt-2 text-xs text-muted-foreground">{entry.definition.restriction.kind === 'deny' ? 'Block matching actions' : `Stop matching actions at ${entry.definition.restriction.seconds} seconds of the original task`}. Missing facts: {entry.definition.onUnavailable}.</p>
          <NativeProtectedChange title="Retire this rule" change={{ kind: 'cardinal.retire', ruleId: entry.ruleId, policy: settings.rules!.reference }}
            devices={settings.devices} enabled={catalog?.capabilities?.permanentChanges === true} refreshed={load} />
        </div>)}</div>
        {settings && !settings.rules?.document.rules.length ? <p className="text-sm text-muted-foreground">No permanent Cardinal Rules have been activated.</p> : null}
      </Card>
      <Card><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Drafts in the Vault</CardTitle>
        <Button variant="secondary" disabled={!catalog} onClick={() => { setSelected(null); setEditing(true); }}>New rule</Button></div>
        <ul className="mt-3 space-y-2">{settings?.drafts.map(draft => <li key={draft.reference.recordId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
          <div><p className="text-sm font-medium">{typeof (draft.document.draft as CardinalRule)?.label === 'string' ? (draft.document.draft as CardinalRule).label : 'Rule draft'}</p>
            <p className="text-xs text-muted-foreground">Version {draft.reference.version} · {draft.document.tested?.review.status === 'available' ? 'Saved model advice' : draft.document.tested ? 'Model review needs attention' : 'Review pending'}</p></div>
          <Button variant="secondary" onClick={() => choose(draft)}>Open draft</Button>
        </li>)}</ul>
        {!settings?.drafts.length ? <p className="mt-2 text-sm text-muted-foreground">Saved drafts remain inactive until permanent approval.</p> : null}
      </Card>
      {editing && catalog ? <RuleEditor key={selected ? `${selected.reference.recordId}:${selected.reference.version}` : 'new'} catalog={catalog} selected={selected}
        settings={settings} refreshed={load} saved={async draft => { setSelected(draft); await load(); }} /> : null}
    </> : tab === 'permissions' ? <PermissionsView settings={settings} /> : <ProtectedDevicesView devices={settings?.devices}
      enabled={catalog?.capabilities?.deviceEnrollment === true} revocationEnabled={catalog?.capabilities?.deviceRevocation === true} refreshed={load} />}
  </div>;
}

function ProtectedDevicesView({ devices, enabled, revocationEnabled, refreshed }: {
  devices?: ProtectedDeviceInventory; enabled: boolean; revocationEnabled: boolean; refreshed(): Promise<void>;
}) {
  return <Card><CardTitle>Your protected confirmation devices</CardTitle>
    <p className="text-sm text-muted-foreground">These devices confirm permanent administrator changes. Enrollment alone gives no browser or computer access.</p>
    {devices?.reconciliationRequired ? <ErrorNote>Vault recovery must be reconciled before a device can approve another change.</ErrorNote> : null}
    {!devices ? <p className="mt-3 text-sm text-muted-foreground">The device inventory is unavailable.</p>
      : !devices.devices.length ? <p className="mt-3 text-sm text-muted-foreground">You have no enrolled confirmation devices.</p>
      : <ul className="mt-4 space-y-3">{devices.devices.map(device => <li key={device.enrollmentId} className="rounded-lg border border-border p-3">
        <p className="font-medium">{device.label} <span className="ml-2 text-xs text-muted-foreground">{device.revokedAt ? 'Revoked' : 'Enrolled'}</span></p>
        <p className="mt-1 break-all text-sm">{device.identity.serverOrigin}</p>
        <p className="mt-1 text-xs text-muted-foreground">Enrolled {new Date(device.enrolledAt).toLocaleString()}</p>
        <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Verify device identity</summary>
          <p className="mt-2 break-all">Device: {device.identity.deviceId}</p>
          <p className="mt-1 break-all">Signing key: {device.signingFingerprint}</p>
          <p className="mt-1 break-all">Hardware wrapping key: {device.wrappingFingerprint}</p>
        </details>
        {!device.revokedAt && devices.reference ? <NativeProtectedChange title="Revoke this device"
          change={{ kind: 'device.revoke', enrollmentId: device.enrollmentId, expected: devices.reference }}
          devices={devices} enabled={revocationEnabled} refreshed={refreshed} /> : null}
      </li>)}</ul>}
    <DeviceEnrollment enabled={enabled} vaultReady={!!devices && !devices.reconciliationRequired} refreshed={refreshed} />
    <p className="mt-4 text-xs text-muted-foreground">Revocation stops protected confirmations from that key. It does not sign out websites or erase this Mac’s local hardware key.</p>
  </Card>;
}

function RuleEditor({ catalog, selected, saved, settings, refreshed }: { catalog: Catalog; selected: CardinalDraftView | null;
  saved: (draft: CardinalDraftView) => Promise<void>; settings: Settings | null; refreshed(): Promise<void> }) {
  const previous = selected?.document.draft as CardinalRule | undefined;
  const [label, setLabel] = useState(previous?.label ?? ''), [wording, setWording] = useState(previous?.wording ?? '');
  const [allActions, setAllActions] = useState(previous?.actions === '*');
  const [actions, setActions] = useState<string[]>(Array.isArray(previous?.actions) ? previous.actions : []);
  const [scopes, setScopes] = useState<Record<string, string>>(() => Object.fromEntries(catalog.scopeKeys.map(key => {
    const scope = previous?.scope[key as keyof CardinalRule['scope']];
    return [key, scope === '*' ? '*' : scope?.ids?.join(', ') ?? ''];
  })));
  const [restriction, setRestriction] = useState(previous?.restriction.kind ?? '');
  const [seconds, setSeconds] = useState(previous?.restriction.kind === 'maximum_task_duration' ? String(previous.restriction.seconds) : '');
  const [unavailable, setUnavailable] = useState(previous?.onUnavailable ?? '');
  const [password, setPassword] = useState(''), [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [check, setCheck] = useState<Check | null>(null), [preview, setPreview] = useState<ReviewPreview | null>(null);
  const draft = { schemaVersion: 1, label, wording, actions: allActions ? '*' : actions,
    scope: Object.fromEntries(catalog.scopeKeys.map(key => [key, scopes[key] === '*' ? '*' : { ids: scopes[key].split(',').map(id => id.trim()).filter(Boolean) }])),
    restriction: restriction === 'maximum_task_duration' ? { kind: restriction, seconds: seconds ? Number(seconds) : null } : { kind: restriction },
    onUnavailable: unavailable };
  const serialized = canonical(draft);
  const unchanged = !!previous && serialized === canonical(previous);
  const report = check?.report ?? (unchanged ? selected?.document.tested?.report : null);
  useEffect(() => { setCheck(null); setPreview(null); setError(''); }, [serialized]);
  async function run(kind: 'check' | 'save' | 'preview' | 'test') {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (kind === 'check') setCheck(await api.post<Check>('/admin/automation/rules/validate', { draft }));
      if (kind === 'save') {
        const result = await api.post<{ draft: CardinalDraftView }>('/admin/automation/rules/save', { draft,
          ...(selected ? { expected: selected.reference } : {}), password, mfaCode });
        await saved(result.draft);
      }
      if (kind === 'preview' && selected && unchanged) setPreview(await api.post<ReviewPreview>(
        `/admin/automation/rules/${selected.reference.recordId}/review-preview`, { expected: selected.reference }));
      if (kind === 'test' && selected && unchanged && preview?.canTransmit && preview.reviewer) {
        const { providerId, model, configurationVersion } = preview.reviewer;
        const result = await api.post<{ draft: CardinalDraftView }>(`/admin/automation/rules/${selected.reference.recordId}/test`, {
          expected: selected.reference, approvedReviewInputDigest: preview.inputDigest,
          reviewerIdentity: { providerId, model, configurationVersion }, password, mfaCode,
        });
        await saved(result.draft);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The draft could not be updated.'); }
    finally { setBusy(false); setPassword(''); setMfaCode(''); }
  }
  return <Card><CardTitle>{selected ? 'Edit rule draft' : 'New rule draft'}</CardTitle>
    <fieldset disabled={busy} className="space-y-4">
      <label className="block text-sm">Rule name<Input maxLength={120} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label className="block text-sm">Your wording<textarea rows={3} maxLength={4000} value={wording} onChange={event => setWording(event.target.value)} className={`${fieldClass} py-2`} /></label>
      <fieldset className="rounded-lg border border-border p-3"><legend className="px-1 text-sm font-medium">Actions covered</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={allActions} onChange={event => setAllActions(event.target.checked)} />Every supported action</label>
        {!allActions ? <div className="grid gap-x-4 sm:grid-cols-2">{catalog.actions.map(action => <label key={action} className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={actions.includes(action)} onChange={event => setActions(current => event.target.checked ? [...current, action] : current.filter(value => value !== action))} />
          {action.replaceAll('.', ' · ')}
        </label>)}</div> : null}
      </fieldset>
      <fieldset className="rounded-lg border border-border p-3"><legend className="px-1 text-sm font-medium">Where this rule applies</legend>
        <div className="space-y-3">{catalog.scopeKeys.map(key => <div key={key}>
          <label className="block text-sm">{scopeLabels[key]}
            <select className={fieldClass} value={scopes[key] === '*' ? '*' : scopes[key] ? 'selected' : ''}
              onChange={event => setScopes(current => ({ ...current, [key]: event.target.value === '*' ? '*' : event.target.value === 'selected' ? ' ' : '' }))}>
              <option value="">Choose explicitly</option><option value="*">All</option><option value="selected">Exact identities</option>
            </select></label>
          {scopes[key] && scopes[key] !== '*' ? <label className="mt-1 block text-xs text-muted-foreground">Identity IDs, separated by commas
            <Input value={scopes[key]} maxLength={4000} onChange={event => setScopes(current => ({ ...current, [key]: event.target.value || ' ' }))} />
          </label> : null}
        </div>)}</div>
      </fieldset>
      <label className="block text-sm">Restriction<select className={fieldClass} value={restriction} onChange={event => setRestriction(event.target.value as typeof restriction)}>
        <option value="">Choose a restriction</option><option value="deny">Block matching actions</option><option value="maximum_task_duration">Limit the original task's duration</option>
      </select></label>
      {restriction === 'maximum_task_duration' ? <label className="block text-sm">Maximum seconds, including retries
        <Input type="number" min={1} max={31536000} step={1} value={seconds} onChange={event => setSeconds(event.target.value)} /></label> : null}
      <label className="block text-sm">When required facts cannot be verified<select className={fieldClass} value={unavailable} onChange={event => setUnavailable(event.target.value as typeof unavailable)}>
        <option value="">Choose explicitly</option><option value="deny">Deny the action</option><option value="pause">Pause and ask for instructions</option>
      </select></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void run('check')}>Test validity</Button>
        <Button variant="secondary" disabled={busy || !selected || !unchanged} onClick={() => void run('preview')}>Preview model review</Button></div>
      {report ? <div className="rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">{report.status === 'passed' ? 'Structured checks passed' : 'This rule needs changes'}</p>
        <ul className="mt-2 list-disc pl-5">{report.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
        {check?.meaning ? <p className="mt-2 whitespace-pre-wrap">{check.meaning}</p> : null}
        <p className="mt-2 text-xs text-muted-foreground">{report.cases.filter(item => item.passed).length}/{report.cases.length} simulations passed. Model advice and permanent approval are separate.</p>
      </div> : null}
      {selected?.document.tested?.review.status === 'available' ? <div className="rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">Saved model advice · {selected.document.tested.review.assessment.clarity === 'clear' ? 'Meaning appears clear' : 'Clarification suggested'}</p>
        <p>{selected.document.tested.review.assessment.summary}</p>
        <ul className="mt-2 list-disc pl-5">{selected.document.tested.review.assessment.concerns.map((value, index) => <li key={index}>{value}</li>)}</ul>
        {selected.document.tested.review.assessment.suggestions.length ? <>
          <p className="mt-3 font-medium">Suggestions for your decision</p>
          <ul className="mt-1 list-disc pl-5">{selected.document.tested.review.assessment.suggestions.map((value, index) => <li key={index}>{value}</li>)}</ul>
        </> : null}
        <p className="mt-2 text-xs text-muted-foreground">{selected.document.tested.reviewer.providerId} · {selected.document.tested.reviewer.model || 'Configured default model'}</p>
        <p className="mt-2 text-xs text-muted-foreground">This advice refers to the saved version. Editing requires another review.</p>
      </div> : null}
      {selected?.document.tested && selected.document.tested.review.status !== 'available'
        ? <ErrorNote>{selected.document.tested.review.message} Preview and explicitly request another review when ready.</ErrorNote> : null}
      {preview ? <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">Exact content for the model</p>
        <p>{preview.reviewer ? `${preview.reviewer.providerId} · ${preview.reviewer.model || 'Configured default model'}${preview.reviewer.external ? ' · External provider' : ''}` : 'No activated model is available.'}</p>
        <p className="whitespace-pre-wrap">{preview.input.wording}</p><p className="whitespace-pre-wrap">{preview.input.structuredMeaning}</p>
        <p className="whitespace-pre-wrap text-muted-foreground">{preview.input.guidance}</p>
        <p className="text-muted-foreground">{preview.reason} Nothing has been sent.</p>
      </div> : null}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-sm font-medium">Verify this administrator action</p>
        <label className="block text-sm">Administrator password<Input type="password" autoComplete="current-password" value={password} maxLength={4096} onChange={event => setPassword(event.target.value)} /></label>
        <label className="block text-sm">Authenticator code, if enabled<Input inputMode="numeric" autoComplete="one-time-code" value={mfaCode} maxLength={200} onChange={event => setMfaCode(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !password} onClick={() => void run('save')}>{busy ? 'Working…' : 'Save draft'}</Button>
          {preview ? <Button variant="secondary" disabled={busy || !password || !unchanged || !preview.canTransmit} onClick={() => void run('test')}>
            {busy ? 'Working…' : 'Send preview and test rule'}
          </Button> : null}
        </div>
        <p className="text-xs text-muted-foreground">Sending the preview requests one model review and saves the advice to the Vault. The model cannot approve the rule. Permanent approval uses the protected native confirmation.</p>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </fieldset>
    {selected && unchanged && selected.document.tested?.report.status === 'passed' && selected.document.tested.review.status === 'available' && settings
      ? <NativeProtectedChange title="Make permanent" change={{ kind: 'cardinal.activate', draft: selected.reference, policy: settings.rules?.reference ?? null }}
          devices={settings.devices} enabled={catalog.capabilities?.permanentChanges === true} refreshed={refreshed} />
      : <p className="mt-3 text-xs text-muted-foreground">Save and test the current draft before requesting permanent approval.</p>}
  </Card>;
}

function scopeDescription(scope: PermissionScope): string {
  switch (scope.kind) {
    case 'browser': return `${scope.browser}: ${scope.origin} · Profile ${scope.profileId}`;
    case 'network': return `${scope.origin} · ${scope.networkClass} network`;
    case 'file': return `Approved folder ${scope.rootId}: /${scope.segments.join('/')}${scope.descendants ? ' and descendants' : ''}`;
    case 'application': return `Application ${scope.applicationId}, installation ${scope.installationRevision}`;
    case 'runtime': return `Runtime ${scope.runtimeId}, sandbox ${scope.sandboxId}`;
    case 'credential': return `Vault item ${scope.itemId}, version ${scope.itemVersion} → ${scopeDescription(scope.destination)}`;
    case 'model': return `Model configuration ${scope.configurationId}, version ${scope.configurationRevision}`;
    case 'workspace': return 'This automation workspace';
  }
}
function PermissionsView({ settings }: { settings: Settings | null }) {
  return <div className="space-y-4"><Card><CardTitle>Strict, scoped permissions</CardTitle>
    <p className="text-sm text-muted-foreground">Each grant applies to one person, server, device and isolated workspace. Rules can deny, ask each time, allow a task, expire at a chosen time, or remain allowed within explicit limits.</p>
    <p className="mt-2 text-sm text-muted-foreground">Actions without a matching grant are denied or ask for instructions. Cardinal Rules always restrict grants. Automation cannot change its own permissions or manage the Vault.</p>
  </Card>
    {settings?.permissions?.reconciliationRequired || settings?.permissions && !settings.permissions.enforcementCurrent
      ? <ErrorNote>Permissions need recovery reconciliation or revalidation before use.</ErrorNote> : null}
    {settings?.permissions?.document.policies.map(policy => <Card key={Object.values(policy.identity).join(':')}>
      <CardTitle>{policy.enabled ? 'Enabled permission policy' : 'Disabled permission policy'}</CardTitle>
      <dl className="my-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">{Object.entries(policy.identity).map(([key, value]) =>
        <div key={key}><dt>{scopeLabels[key] ?? key}</dt><dd className="break-all">{value}</dd></div>)}</dl>
      <p className="text-sm">Without a matching rule: {policy.unmatched === 'deny' ? 'Deny' : 'Ask for instructions'}</p>
      <ul className="mt-3 space-y-3">{policy.rules.map(rule => <li key={rule.id} className="rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">{rule.action.replaceAll('.', ' · ')}</p><p className="mt-1 break-words">{scopeDescription(rule.scope)}</p>
        <p className="mt-1">{rule.mode.kind === 'until' ? `Allowed until ${new Date(rule.mode.expiresAt).toLocaleString()}`
          : rule.mode.kind === 'task' ? `Only task ${rule.mode.taskId}` : rule.mode.kind === 'standing' ? 'Standing grant' : rule.mode.kind === 'ask' ? 'Ask each time' : 'Denied'}</p>
        {rule.limits ? <p className="mt-2 text-xs text-muted-foreground">Per original task: {rule.limits.maxActionsPerTask ?? 'unlimited'} actions · {rule.limits.maxBytesPerTask ?? 'unlimited'} bytes · {rule.limits.maxTaskDurationMs === null ? 'unlimited duration' : `${rule.limits.maxTaskDurationMs / 1000} seconds`}</p> : null}
      </li>)}</ul>
    </Card>)}
    {settings && !settings.permissions?.document.policies.length ? <Card><p className="text-sm text-muted-foreground">No automation grants are active. Device pairing and protected confirmation are required before a workspace can receive grants.</p></Card> : null}
  </div>;
}
