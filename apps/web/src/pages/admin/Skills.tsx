// The Skills library.
//
// One page, four things, and it must not imply a fifth:
//
//   1. INSTALLED. What is here, where each one came from, what it says it wants
//      to use, and — in full, not summarised — what it tells Josi to do.
//   2. AVAILABLE. What each source is offering. Browsing shows a name, a
//      version and a publisher; it never shows a stranger's prose, because
//      nothing has been fetched yet.
//   3. SOURCES. Where packages may come from at all. This list IS the trust
//      list: there is no field anywhere on this page for a package address.
//   4. QUARANTINE. What was refused, and why. No route promotes one of these
//      into the library, and their text was never stored.
//
// The fifth thing, which does not exist here on purpose: a way to switch a
// skill on without reading it. The activate control carries the digest of the
// text that was on screen, so a package that changed between the reading and
// the pressing is refused rather than approved.
//
// WHAT A SKILL CANNOT DO is said on the page rather than left to the docs,
// because the assumption in the other direction is the dangerous one. A skill
// is instructions. It cannot hand the assistant a tool, reach a connection
// somebody has not switched on, or let a write happen without the person
// agreeing to it — and what it says it uses is checked against each person's own
// connections every time it is used.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface Source {
  id: string;
  sourceKind: string;
  name: string;
  indexUrl: string | null;
  host: string | null;
  publicKey: string | null;
  signed: boolean;
  enabled: boolean;
  lastIndexAt: string | null;
  lastIndexOk: boolean | null;
  lastErrorCategory: string | null;
  removable: boolean;
}

interface Capability { key: string; label: string }

interface HistoryEntry {
  action: string;
  version: string;
  digest: string;
  signatureState: string;
  originName: string;
  at: string;
}

interface Skill {
  id: string;
  key: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  license: string | null;
  homepage: string | null;
  instructions: string;
  capabilitiesRequested: Capability[];
  dependencies: Array<{ key: string; minVersion: string | null }>;
  missingDependencies: string[];
  provenance: { sourceId: string; originKind: string; originName: string; originUrl: string | null };
  digest: string;
  reviewed: boolean;
  signatureState: string;
  signatureKeyId: string | null;
  skillState: string;
  installedAt: string;
  activatedAt: string | null;
  lastUpdateCheckAt: string | null;
  history: HistoryEntry[];
}

interface Quarantined {
  id: string;
  key: string;
  name: string;
  version: string;
  originName: string;
  reason: string;
  detail: string | null;
  digest: string | null;
  at: string;
}

interface Available {
  key: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  capabilities: Capability[];
  digest: string;
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
}

export function AdminSkills() {
  const [sources, setSources] = useState<Source[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [quarantine, setQuarantine] = useState<Quarantined[]>([]);
  const [limit, setLimit] = useState(50);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{
        sources: Source[]; skills: Skill[]; quarantine: Quarantined[]; limit: number;
      }>('/admin/skills');
      setSources(res.sources);
      setSkills(res.skills);
      setQuarantine(res.quarantine);
      setLimit(res.limit);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the skills library');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(id: string, run: () => Promise<{ note?: string } | void>) {
    setBusy(id);
    setError('');
    setNote('');
    try {
      const res = await run();
      if (res && 'note' in res && res.note) setNote(res.note);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Skills</h1>
      <p className="text-sm text-muted-foreground">
        A skill is a set of written instructions — a runbook Josi follows for a kind of work.
        It is not a program and it is not a permission: a skill cannot give Josi a tool it does not
        have, reach an account somebody has not connected, or let anything happen that a person
        would otherwise have had to agree to. What a skill says it uses is checked against each
        person&rsquo;s own connections every time.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {note ? <p className="rounded-md border border-border bg-secondary/40 p-3 text-sm">{note}</p> : null}

      <Card>
        <CardTitle>Installed</CardTitle>
        {!skills.length ? (
          <Empty title="Nothing is installed">
            Nothing ships switched on. Look under Available below to see what the starter catalogue
            and any registries you have added are offering.
          </Empty>
        ) : (
          <ul className="space-y-4">
            {skills.map((skill) => (
              <li key={skill.id} className="border-t border-border pt-4 first:border-0 first:pt-0">
                <InstalledSkill
                  skill={skill}
                  busy={busy === skill.id}
                  onActivate={() => act(skill.id, () => api.post<{ note?: string }>(
                    `/admin/skills/${skill.id}/activate`, { digest: skill.digest },
                  ))}
                  onToggle={() => act(skill.id, () => api.post<{ note?: string }>(
                    `/admin/skills/${skill.id}/${skill.skillState === 'enabled' ? 'disable' : 'enable'}`,
                  ))}
                  onUpdate={() => act(skill.id, () => api.post<{ note?: string }>(`/admin/skills/${skill.id}/update`))}
                  onRemove={() => act(skill.id, () => api.del<{ note?: string }>(`/admin/skills/${skill.id}`))}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {skills.length} of {limit} installed. Every switched-on skill is read on every message, for
          everybody here.
        </p>
      </Card>

      {sources.map((source) => (
        <SourceCatalogue
          key={source.id}
          source={source}
          onInstalled={(installedNote) => { setNote(installedNote); void load(); }}
          onError={setError}
        />
      ))}

      <Sources sources={sources} busy={busy} onAct={act} onReload={load} onError={setError} />

      {quarantine.length ? (
        <Card>
          <CardTitle>Quarantined</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            Packages Josi refused to trust. None of them is installed and none can be; their text was
            not kept, because the reason each one is here is that its text could not be trusted.
            Clearing an entry removes the record, not a block — installing it means fixing whatever
            failed and installing again.
          </p>
          <ul className="space-y-3">
            {quarantine.map((item) => (
              <li key={item.id} className="border-t border-border pt-3 first:border-0 first:pt-0">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-medium">
                    {item.name} {item.version}
                  </span>
                  <Badge tone="danger">{plain('skill_quarantine_reason', item.reason)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  offered as &ldquo;{item.key}&rdquo; by {item.originName}
                </p>
                {plainDetail('skill_quarantine_reason', item.reason) ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {plainDetail('skill_quarantine_reason', item.reason)}
                  </p>
                ) : null}
                {item.detail ? <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p> : null}
                <Button
                  className="mt-2"
                  variant="secondary"
                  disabled={busy === item.id}
                  onClick={() => act(item.id, () => api.del(`/admin/skills/quarantine/${item.id}`))}
                >
                  Clear this record
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/** One installed skill: what it is, where it came from, what it asks for, and —
 * behind a disclosure that says what it is for — every word of it.
 *
 * The instructions are not truncated and are not summarised. Reviewing a skill
 * IS reading them, and a page that showed the first three lines would be a page
 * that made the review it asks for impossible. */
function InstalledSkill({
  skill, busy, onActivate, onToggle, onUpdate, onRemove,
}: {
  skill: Skill;
  busy: boolean;
  onActivate: () => void;
  onToggle: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const on = skill.skillState === 'enabled';
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium">{skill.name} {skill.version}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone={on ? 'ok' : 'muted'}>{plain('skill_state', skill.skillState)}</Badge>
          <Badge tone={skill.signatureState === 'unsigned' ? 'muted' : 'ok'}>
            {plain('skill_signature', skill.signatureState)}
          </Badge>
        </div>
      </div>
      {skill.summary ? <p className="mt-1 text-sm text-muted-foreground">{skill.summary}</p> : null}

      <p className="mt-1 text-xs text-muted-foreground">
        Published by {skill.publisher} · {plain('skill_source_kind', skill.provenance.originKind)}
        {' '}({skill.provenance.originName})
        {skill.license ? ` · ${skill.license}` : ''}
      </p>
      <p className="text-xs text-muted-foreground">
        {plainDetail('skill_signature', skill.signatureState)}
      </p>

      {/* What it says it wants. Named as a request, never as a grant: this is a
          declaration by its publisher and it changes nobody's permissions. */}
      <div className="mt-2">
        <p className="text-sm font-medium">What it says it uses</p>
        {skill.capabilitiesRequested.length ? (
          <ul className="mt-1 space-y-1">
            {skill.capabilitiesRequested.map((capability) => (
              <li key={capability.key} className="text-sm text-muted-foreground">· {capability.label}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing beyond ordinary conversation.</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Asking is not having. Each of these is checked against the connections of whoever is
          talking to Josi, at the moment they talk to it.
        </p>
      </div>

      {skill.dependencies.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Expects these other skills: {skill.dependencies.map((d) => d.key).join(', ')}.
          {skill.missingDependencies.length
            ? ` Not satisfied here: ${skill.missingDependencies.join('; ')}. Josi does not install these for you.`
            : ''}
        </p>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">
          Read what this tells Josi to do ({skill.instructions.length} characters)
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-secondary/30 p-3 text-xs">
          {skill.instructions}
        </pre>
        <p className="mt-1 text-xs text-muted-foreground">
          Written by {skill.publisher}, not by Josi. Josi shows it to the assistant as a document
          from them, and tells it that nothing in here can outrank its own rules.
        </p>
      </details>

      {!skill.reviewed ? (
        <div className="mt-3 rounded-md border border-border bg-secondary/40 p-3">
          <p className="text-sm">
            This version has not been read here yet, so it is doing nothing.
            {skill.activatedAt ? ' An earlier version of it was switched on; an update does not carry that over.' : ''}
          </p>
          <Button className="mt-2" disabled={busy} onClick={onActivate}>
            I have read this — switch it on
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant={on ? 'primary' : 'secondary'} disabled={busy} aria-pressed={on} onClick={onToggle}>
            {on ? 'On' : 'Off'}
          </Button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={onUpdate}>Check for updates</Button>
        <Button variant="secondary" disabled={busy} onClick={onRemove}>Remove</Button>
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-muted-foreground">History</summary>
        <ul className="mt-1 space-y-1">
          {skill.history.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="text-xs text-muted-foreground">
              {new Date(entry.at).toLocaleString()} — {plain('skill_history_action', entry.action)}
              {' '}({entry.version}, from {entry.originName})
            </li>
          ))}
          {!skill.history.length ? <li className="text-xs text-muted-foreground">Nothing recorded.</li> : null}
        </ul>
      </details>
    </>
  );
}

/** What one source is offering.
 *
 * Loaded on request rather than on page load. Fetching a catalogue is an
 * outbound request from the operator's own server, and a page that made four of
 * them every time somebody opened it would be a page that decided that on their
 * behalf. The built-in catalogue is free — it is in the release — and is opened
 * by the same press for consistency. */
function SourceCatalogue({
  source, onInstalled, onError,
}: {
  source: Source;
  onInstalled: (note: string) => void;
  onError: (message: string) => void;
}) {
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [busy, setBusy] = useState('');

  async function browse() {
    setBusy('browse');
    onError('');
    try {
      const res = await api.get<{ available: Available[] }>(`/admin/skills/sources/${source.id}/catalogue`);
      setAvailable(res.available);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not read that catalogue');
    } finally {
      setBusy('');
    }
  }

  async function install(entry: Available) {
    setBusy(entry.key);
    onError('');
    try {
      const res = await api.post<{ note?: string }>('/admin/skills/install', {
        sourceId: source.id, skillKey: entry.key,
      });
      onInstalled(res.note ?? 'Installed.');
      await browse();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not install that');
    } finally {
      setBusy('');
    }
  }

  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <CardTitle>Available from {source.name}</CardTitle>
        <Badge tone={source.enabled ? 'muted' : 'danger'}>
          {plain('skill_source_kind', source.sourceKind)}
        </Badge>
      </div>
      {!source.enabled ? (
        <p className="text-sm text-muted-foreground">
          This source is switched off, so nothing can be installed from it.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {source.sourceKind === 'builtin'
              ? 'The starter catalogue that ships inside this release. Nothing here is installed, and '
                + 'nothing here is switched on, until you do both.'
              : `Josi asks ${source.host} what it offers. A listing carries a name and a version and `
                + 'no instructions at all — reading a skill is what installing it makes possible.'}
          </p>
          <Button disabled={busy === 'browse'} onClick={() => void browse()}>
            {busy === 'browse' ? 'Asking…' : available ? 'Refresh' : 'See what it offers'}
          </Button>

          {available && !available.length ? (
            <p className="mt-3 text-sm text-muted-foreground">It is offering nothing Josi can read.</p>
          ) : null}

          {available?.length ? (
            <ul className="mt-3 space-y-3">
              {available.map((entry) => (
                <li key={entry.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">
                      {entry.name} {entry.version}
                    </span>
                    {entry.installed ? (
                      <Badge tone={entry.updateAvailable ? 'danger' : 'ok'}>
                        {entry.updateAvailable ? `installed: ${entry.installedVersion}` : 'installed'}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">by {entry.publisher}</p>
                  {entry.summary ? <p className="mt-1 text-sm text-muted-foreground">{entry.summary}</p> : null}
                  {entry.capabilities.length ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Says it uses: {entry.capabilities.map((c) => c.label).join('; ')}
                    </p>
                  ) : null}
                  {!entry.installed ? (
                    <Button
                      className="mt-2"
                      variant="secondary"
                      disabled={busy === entry.key}
                      onClick={() => void install(entry)}
                    >
                      {busy === entry.key ? 'Fetching…' : 'Install (it stays off until you read it)'}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Where packages may come from. THIS LIST IS THE TRUST LIST — there is no
 * field on this page for a package address, and an install names a source and a
 * key rather than a URL. */
function Sources({
  sources, busy, onAct, onReload, onError,
}: {
  sources: Source[];
  busy: string;
  onAct: (id: string, run: () => Promise<{ note?: string } | void>) => Promise<void>;
  onReload: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [indexUrl, setIndexUrl] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [sourceKind, setSourceKind] = useState('registry');
  const [adding, setAdding] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setAdding(true);
    onError('');
    try {
      await api.post('/admin/skills/sources', {
        sourceKind, name: name.trim(), indexUrl: indexUrl.trim(), publicKey: publicKey.trim() || null,
      });
      setName('');
      setIndexUrl('');
      setPublicKey('');
      await onReload();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not add that source');
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card>
      <CardTitle>Where skills may come from</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">
        Josi installs only from this list. There is nowhere on this page to paste a package: an
        install names a source and a skill, and the address comes from that source&rsquo;s own
        catalogue. Packages are fetched over https from the address below and nowhere else, and no
        credential is ever sent.
      </p>

      <ul className="space-y-3">
        {sources.map((source) => (
          <li key={source.id} className="border-t border-border pt-3 first:border-0 first:pt-0">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm font-medium">{source.name}</span>
              <Badge tone={source.enabled ? 'ok' : 'muted'}>
                {source.enabled ? 'in use' : 'switched off'}
              </Badge>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {plain('skill_source_kind', source.sourceKind)}
              {source.indexUrl ? ` · ${source.indexUrl}` : ' · nothing is fetched'}
            </p>
            <p className="text-xs text-muted-foreground">
              {source.signed
                ? 'Publishes a signing key, so every package from here must be signed by it.'
                : 'Publishes no signing key. Packages are pinned by digest and say so.'}
            </p>
            {source.lastErrorCategory ? (
              <p className="mt-1 text-sm text-destructive">
                {plain('connector_error', source.lastErrorCategory)}.
                {' '}{plainDetail('connector_error', source.lastErrorCategory) ?? ''}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy === source.id}
                onClick={() => void onAct(source.id, () => api.post<{ note?: string }>(
                  `/admin/skills/sources/${source.id}/${source.enabled ? 'disable' : 'enable'}`,
                ))}
              >
                {source.enabled ? 'Switch off' : 'Switch on'}
              </Button>
              {source.removable ? (
                <Button
                  variant="secondary"
                  disabled={busy === source.id}
                  onClick={() => void onAct(source.id, () => api.del(`/admin/skills/sources/${source.id}`))}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <form className="mt-4 space-y-3 border-t border-border pt-4" onSubmit={(e) => void add(e)}>
        <p className="text-sm font-medium">Add a source</p>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">What it is</span>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value)}
          >
            <option value="registry">A curated registry you trust</option>
            <option value="repository">One repository you are pointing Josi at</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Our internal skills" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Catalogue address</span>
          <Input
            value={indexUrl}
            onChange={(e) => setIndexUrl(e.target.value)}
            placeholder="https://example.com/skills/index.json"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            The index document itself. Packages are fetched from addresses inside its own directory
            on the same host, and from nowhere else.
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Signing key (optional)</span>
          <Input
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="base64 ed25519 public key"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            If the publisher gives you one, paste it. Every package from this source will then have to
            be signed by it or Josi quarantines it. Without a key Josi can still check that a package
            matches the digest its catalogue pinned, but not who wrote it.
          </span>
        </label>
        <Button type="submit" disabled={adding || !name.trim() || !indexUrl.trim()}>
          {adding ? 'Adding…' : 'Add source'}
        </Button>
      </form>
    </Card>
  );
}
