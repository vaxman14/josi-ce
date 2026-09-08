// What Josi has been taught, as the person it works for sees it.
//
// READ-ONLY, AND COMPLETE. There is no control on this page and there is no
// route behind one: installing a skill means reading prose that will sit near
// the assistant's own instructions for everybody here, and that is an
// administrative act in exactly the way reviewing a custom API action is.
//
// What a member is owed instead is the TEXT — all of it. A skill changes how
// Josi answers this person about this person's own work, so "what exactly has
// it been told?" is a question they should be able to answer without asking
// anybody. A page that showed a title and a summary would be asking them to
// trust a review they cannot check.
//
// And the second half, which is the one that makes a skill safe to have: what a
// skill says it uses is resolved AGAINST THIS PERSON'S OWN CONNECTIONS, by the
// same function that builds the assistant's turn. If it says a skill's calendar
// access is not available to you, that is because your next message would say
// so too.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardTitle, Empty, ErrorNote } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface CapabilityVerdict {
  key: string;
  label: string;
  available: boolean;
  hint?: string;
}

interface Skill {
  key: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  license: string | null;
  homepage: string | null;
  instructions: string;
  capabilities: CapabilityVerdict[];
  dependencies: Array<{ key: string; minVersion: string | null }>;
  missingDependencies: string[];
  provenance: {
    originKind: string;
    originName: string;
    signatureState: string;
    signatureKeyId: string | null;
    digest: string;
  };
  skillState: string;
  installedAt: string;
  activatedAt: string | null;
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<{ skills: Skill[]; note: string }>('/skills')
      .then((res) => { setSkills(res.skills); setNote(res.note); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load skills'));
  }, []);

  const active = skills?.filter((skill) => skill.skillState === 'enabled') ?? [];
  const inactive = skills?.filter((skill) => skill.skillState !== 'enabled') ?? [];

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Skills</h1>
      <p className="text-sm text-muted-foreground">{note || 'What Josi has been taught to do here.'}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!skills ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {skills && !skills.length ? (
        <Empty title="Nothing is installed">
          Nobody has installed a skill on this installation, so Josi is working from its own
          instructions and nothing else. An administrator adds them under Skills in the admin
          section.
        </Empty>
      ) : null}

      {active.map((skill) => <SkillCard key={skill.key} skill={skill} />)}

      {inactive.length ? (
        <Card>
          <CardTitle>Installed, not in use</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            These are in the library and are doing nothing at all — Josi has not been told about
            them. They are listed so that &ldquo;is that skill on?&rdquo; has an answer here.
          </p>
          <ul className="space-y-2">
            {inactive.map((skill) => (
              <li key={skill.key} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="min-w-0 break-words text-sm">{skill.name} {skill.version}</span>
                <Badge tone="muted">{plain('skill_state', skill.skillState)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardTitle>What a skill cannot do</CardTitle>
        <p className="text-sm text-muted-foreground">
          A skill is instructions and nothing else. It cannot give Josi a tool it did not have, read
          an account you have not connected, widen a permission you have switched off, or make
          something happen that you would otherwise have been asked to agree to. If a skill needs
          something you have not connected, Josi says so rather than finding another way round it —
          the switches on your{' '}
          <Link className="underline" to="/app/connections">Connections</Link> page are still the
          only thing that decides what it may reach.
        </p>
      </Card>
    </div>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <CardTitle>{skill.name}</CardTitle>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone="ok">{plain('skill_state', skill.skillState)}</Badge>
          <Badge tone={skill.provenance.signatureState === 'unsigned' ? 'muted' : 'ok'}>
            {plain('skill_signature', skill.provenance.signatureState)}
          </Badge>
        </div>
      </div>
      {skill.summary ? <p className="text-sm text-muted-foreground">{skill.summary}</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">
        Version {skill.version}, published by {skill.publisher} ·{' '}
        {plain('skill_source_kind', skill.provenance.originKind)} ({skill.provenance.originName})
        {skill.license ? ` · ${skill.license}` : ''}
      </p>
      <p className="text-xs text-muted-foreground">
        {plainDetail('skill_signature', skill.provenance.signatureState)}
      </p>

      {/* Resolved for THIS person. "Available" here means the switch on their own
          Connections page is on, checked at the moment this page loaded and
          checked again on every message. */}
      <div className="mt-3">
        <p className="text-sm font-medium">What it uses, and what you have</p>
        {skill.capabilities.length ? (
          <ul className="mt-1 space-y-1">
            {skill.capabilities.map((capability) => (
              <li key={capability.key} className="flex min-w-0 flex-wrap items-start gap-2 text-sm">
                <Badge tone={capability.available ? 'ok' : 'muted'}>
                  {capability.available ? 'you have this' : 'not connected'}
                </Badge>
                <span className="min-w-0 break-words">
                  {capability.label}
                  {capability.hint ? ` — ${capability.hint}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing beyond ordinary conversation.</p>
        )}
      </div>

      {skill.missingDependencies.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This skill expects other skills that are not in place here:{' '}
          {skill.missingDependencies.join('; ')}.
        </p>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">
          Read exactly what Josi is told
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-secondary/30 p-3 text-xs">
          {skill.instructions}
        </pre>
        <p className="mt-1 text-xs text-muted-foreground">
          Written by {skill.publisher}, not by Josi. Josi passes it on as a document from them and
          tells the assistant that nothing in it can outrank Josi&rsquo;s own rules, give it a tool,
          or let it skip asking you about something.
        </p>
      </details>
    </Card>
  );
}
