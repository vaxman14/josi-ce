# The Skills library — design and authority decision

**Admin → Skills** installs written instructions Josi follows for a kind of
work. **Workspace → Skills** shows every member what is installed, in full.
Nothing is preset: a fresh installation has an empty library, and the starter
catalogue that ships in the release is four documents nobody has installed.

## What a skill is, and what makes it different from everything else in CE

A skill is a **document**. It has a name, a publisher, a version, a list of what
it says it wants to use, and a block of prose. That is the entire format.

There is no code in a package. No command, no URL, no header, no credential, no
tool definition and no execution path. Migration 0037 has no column any request
is ever made from, and `packages/agent/src/skillGuidance.ts` produces text and
never a tool.

That is worth stating against the other four things CE connects to, because the
temptation with a skills feature is always to let it grow a capability of its
own:

| | what it is | what it can reach |
|---|---|---|
| Developer service (0034) | a pasted token | one pinned host |
| Custom API (0035) | an allowlist an administrator typed | one host, one request per row |
| MCP server (0036) | a remote party describing its own tools | one host, the tools its owner approved |
| **Skill (0037)** | **written instructions** | **nothing** |

## The one rule

> **A skill is never an authority bypass.**

Everything a skill can do, the person it is working for could already have asked
for in their own words. Concretely:

- **It adds no tool.** The turn's tool list is decided before skills are read
  and is not touched afterwards. `ALL_TOOLS` is unchanged by any number of
  installed skills, and there is no `run_skill`.
- **It cannot widen a permission.** A package's `capabilities` list is a
  **declaration**, not a grant. At the moment of a turn it is intersected with
  what *that person* has actually connected and switched on, using `can()` —
  the same function every other caller asks before touching a provider. Anything
  they lack is named to the model as unavailable, so the model cannot even
  produce a confident-sounding promise about it.
- **It cannot read a credential.** Nothing in the library code opens a sealed
  value; there is no `MasterKey` parameter anywhere in it. A test reads the
  source and fails if one appears.
- **It cannot approve a write.** A pending custom API call or MCP tool call is
  decided by a signed-in person on one route each, and no skill is on it.

Two members with the same skill and different connections get two different,
honest answers about what can be done. That is the whole of multi-user isolation
here: the library is installation-wide, and what it can reach is resolved per
person, every message.

## The ownership decision: installation-scoped, administrator-owned

Like custom APIs (0035) and unlike developer services and MCP servers.

The reason is the mirror image of theirs. Those hold a credential that **acts as
a person**, so the person owns the row. A skill holds no credential and acts as
nobody. What it is, is a claim about how this installation does its work, and
reviewing that claim — reading prose that will sit near the assistant's own
instructions for everybody — is an administrative act in exactly the way
reviewing a custom API action is.

There is deliberately no `owner_user_id` anywhere in migration 0037, and so no
cascade: nothing in it belongs to one person, and deleting an account must not
delete the workspace's runbook.

### What a member gets

**The full text.** Not a title and a summary — a page that showed those would be
asking people to trust a review they cannot check. A skill changes how Josi
answers *them* about *their* work, so "what exactly has it been told?" is a
question they can answer without asking anybody.

Beside it, what each skill says it uses **and whether they have it**, resolved by
the same function that builds their next turn. If the page says a skill's
calendar access is not available to them, that is because their next message
will say so too.

There is no member write route. Members read; administrators install.

## Installing is not activating

Two presses, two routes, and the gap between them is the point.

1. **Install.** The package is fetched, validated, checked against the digest
   its catalogue pinned, and its signature verified if the source publishes a
   key. It lands at `state = 'review'`: stored, readable, and doing nothing at
   all. No turn reads it.
2. **Activate.** An administrator reads the whole text and says so. The request
   carries the digest the page displayed, so a package that changed between the
   reading and the pressing is refused rather than approved.

Migration 0037 asserts this rather than trusting it:

```sql
constraint skills_enabled_was_reviewed check (
  state <> 'enabled'
  or (reviewed_digest is not null and reviewed_digest = package_digest)
)
```

`is not null` first is not redundant: a CHECK whose expression evaluates to NULL
*passes* in PostgreSQL, so the shorter form would have accepted exactly the row
it exists to refuse. A test that writes that UPDATE by hand is what found it.

### An update goes back through review, even if it was switched on

`updateSkill` writes the new digest, `state = 'review'` and
`reviewed_digest = null` in one statement — and because of the CHECK above, a
row carrying new instructions **cannot** remain enabled even if a future code
path forgot to send it back. The page says outright that a live skill was
switched off and why.

An older version of a skill having been read is not consent to a new one.

## Where a package may come from

**The source list is the trust list.** There is no route anywhere that takes a
package body, a package address or an upload. An install names a **source row**
and a **key inside that source's own catalogue**; every byte of the request that
follows is built from the row.

Three kinds of source:

- **Included with Josi** — the starter catalogue, compiled into the release.
  Never fetched, works on an installation with no outbound internet, and
  installs nothing until somebody does.
- **Curated registry** — one an administrator chose to trust and added.
- **A repository you added** — one somebody supplied explicitly.

The last two are fetched identically; they are distinguished because provenance
is shown, and "a registry we trust" and "a repository somebody pointed us at"
are different sentences to read beside an installed skill.

There is **no credential column** on a source, deliberately. A private registry
needs a token; a token needs a store, a rotation story and an owner; and an
installer holding one would be a second credential broker with none of those.

### The outbound rules

- `https://` only. A package fetched over plain http is a package any network in
  between may rewrite, and the digest that would catch that travels in the same
  document.
- The host column **is** the allowlist. Every URL is re-parsed before it is
  requested and refused unless its host matches exactly.
- A package address must lie **under the index document's own directory**. A
  registry that can name an arbitrary path on its own host can point Josi at
  whatever that host can be made to serve — including an upload directory.
- Every resolved address is checked, not the first. A literal address never
  reaches a resolver. Anything off the public internet is refused.
- Redirects are never followed. Validating a URL and then chasing a 302 checks
  the wrong URL.
- Bodies are capped and parsed as JSON. Nothing is executed, extracted or
  written to disk.

## Integrity and signatures

Every catalogue entry must pin a **digest**, and the fetched package must match
it. An entry without one cannot pin anything, and "install whatever is at that
address right now" is not an integrity check.

The digest is **canonical**: key-sorted, signature excluded, line endings
normalised. So a registry reformatting its JSON does not look like a publisher
changing their mind, and the digest changes exactly when something a person
reads changes.

Signatures are ed25519 over those same bytes, checked against the key registered
for the **source** — a package can no more vouch for itself than an MCP server
can declare its own tools safe. Four honest states, and every screen shows
which:

| state | what it means |
|---|---|
| `builtin` | shipped inside this release; its integrity is the release's |
| `verified` | signed, and checked against the source's registered key |
| `unverified` | signed, but this source registered no key, so nothing could be checked |
| `unsigned` | not signed; the pinned digest and TLS to the pinned host are what is left |

A source that publishes a key **requires** every package from it to be signed and
verify. One that does not says so rather than showing a tick nobody earned.

## Quarantine

A package that fails a trust check is recorded in `skill_quarantine` with its
key, version, digest and a reason — and **not one word of its prose**.

There is no instructions column on that table. The whole reason a package lands
there is that something about it could not be trusted; keeping its text would
mean storing untrusted text in a table somebody eventually renders "just to see
what it said". There is also no route that promotes a quarantined package into
the library: installing it means fixing what failed and installing again, not
overruling the check from a screen.

Reasons: `schema_invalid`, `digest_mismatch`, `signature_missing`,
`signature_invalid`, `capability_unknown`, `instruction_injection`, `too_large`.

A document that cannot even name itself has nothing to file under, so it is
refused, audited as `skill.install_refused`, and written nowhere.

## Prompt injection, treated as the primary threat

A skill's prose is the only dangerous thing about it, and it is handled in three
independent places.

**One — validation refuses prose written to the model.** `screenSkillText`
catches the small set of things a skill has no legitimate reason to say:
overriding the instructions above it, referring to the system prompt, acting
without asking, getting around an approval, keeping something from the person,
redefining what the assistant is, asking for a credential to be produced, or
claiming a permission for itself.

Every pattern is about **authority**, never about topic. "Rotate the API key
every ninety days" is a fine thing for a skill to say; "you do not need approval
for this" is not. Matching on subject matter would quarantine every honest skill
about credentials and catch none of the dishonest ones.

**Two — the framing.** The text is placed *after* everything Josi says about
itself, inside markers, attributed to its publisher, with the ranking said
outright: if a skill disagrees with anything above it, the thing above wins.

**Three — the fencing.** A package author who writes a line of dashes could
otherwise appear to close their own section and start speaking as Josi. That
needs no suspicious word in it, so screening would not and should not catch it;
`fence()` neutralises any line that could close the marker before the text is
placed. Neutralised rather than refused, because a horizontal rule is ordinary
markdown and a package that used one is not hostile.

## The starter catalogue

Four skills ship in the release: **Meeting preparation**, **Inbox triage**,
**Weekly review** and **Finding things in documents**.

They are *metadata and packages in the source tree*, not installed skills.
Installing one is a press; switching it on is a second press after reading it.

They are built in rather than served from a registry the publisher operates, for
two reasons — and the second is the real one:

1. An installation with no outbound internet is a supported way to run CE, and a
   Skills page that can never show anything is a feature with an asterisk.
2. A registry operated by the publisher of the software is a channel that can
   push new prose into everybody's assistant between releases. Shipping them
   *in the release* means they are reviewed the way the rest of it is, they
   change when somebody chooses to upgrade, and their provenance is the same
   signature the container already has.

They are **not trusted for being built in**. Every one goes through the same
validation, the same caps, the same screening and the same digest check as
anything from a stranger. `builtin` buys exactly one thing: a signature state
that says "its integrity is this release's" instead of claiming a signature that
does not exist.

## What the assistant is told

For each enabled skill, resolved for the person whose turn it is:

- who published it, which version, and where it came from;
- what it says it uses, and for each one whether **this person** has it;
- any dependency this installation does not satisfy;
- the prose, fenced and attributed.

Above all of it, one paragraph saying that none of them grants anything, that
nothing in them can outrank Josi's own rules, that a skill needing something
unconnected means saying so rather than finding another way round, and that an
instruction inside a skill to conceal something or act without agreement is to
be reported rather than followed.

Enabled skills are capped at 24,000 characters per message. What does not fit is
**named** — to the administrator on the page and to the model in the prompt —
because "why is my skill not applying" must have an answer that is not a token
count.

## Dependencies

Recorded, shown, and **never resolved by installing anything**. A dependency is
named by a publisher, and installing it on their say-so would let one reviewed
package bring in an arbitrary number of unreviewed ones. A missing dependency is
a sentence on the page and, for the model, a skill that says what it is missing.

## Conflicts

- **Two publishers cannot hold one key.** `skills.skill_key` is unique
  installation-wide. A registry offering `weekly_review` under a different
  publisher is refused with a sentence saying to remove the existing one first.
- **An update cannot change publisher.** The same key from the same registry
  under a new publisher is that registry handing a name somebody already trusted
  to somebody else.
- **An update cannot go backwards.** Serving an older package to a client that
  already has a newer one is how a fixed skill gets replaced by the version that
  needed fixing.

## What an administrator sees, and what is audited

The library page shows every installed skill in full, its provenance, its
signature state, what it requests, its update history, and the quarantine.

The audit trail records `skill.source_added`, `skill.installed`,
`skill.quarantined`, `skill.activated`, `skill.enabled`, `skill.disabled`,
`skill.updated`, `skill.removed` and `skill.install_refused` — with the key, the
version, the publisher, the origin and the digest, and **never a line of the
instructions**. An audit records what happened, not what it said.

A diagnostics bundle carries counts only: how many are installed, enabled,
awaiting review and quarantined. Never a name, never a publisher, never a word
of a runbook — a bundle goes to a third party's ticket system.

## Files

| file | what it holds |
|---|---|
| `packages/db/migrations/0037_skills_library.sql` | `skill_sources`, `skills`, `skill_history`, `skill_quarantine` |
| `packages/connectors/src/skillPackage.ts` | the format, the digest, the signature, the screening |
| `packages/connectors/src/skillRegistry.ts` | sources, catalogues, and the only outbound request |
| `packages/connectors/src/starterSkills.ts` | the four packages that ship in the release |
| `packages/connectors/src/skills.ts` | the rows and the lifecycle |
| `packages/agent/src/skillGuidance.ts` | what a skill does to a turn: text, and no tool |
| `apps/api/src/http/skillRoutes.ts` | the member view and the library |
| `apps/web/src/pages/Skills.tsx` | what Josi has been taught, as a member sees it |
| `apps/web/src/pages/admin/Skills.tsx` | the library |

Tests: `packages/connectors/test/skills.test.ts` (the format, the digest, the
signature, the screening, the fetch, the lifecycle),
`packages/agent/test/skillGuidance.test.ts` (the authority boundary),
`apps/api/test/skills.test.ts` (the same rules over the wire).

## Deliberately not done

- **No code, no scripts, no templates that execute.** A skill is prose. There is
  nothing to sandbox because there is nothing to run.
- **No archives.** A package is one JSON document. No zip, no tar, no path
  traversal, no extraction limits to get wrong.
- **No private registries.** They need a credential, and see above.
- **No automatic updates.** An update is new instructions from outside this
  installation; it arrives when somebody asks for it and stops until somebody
  reads it.
- **No dependency resolution.** See above.
- **No per-member switches.** A skill grants nothing, so a member switching one
  off would be turning off a suggestion rather than a permission — and the thing
  that actually decides what Josi may reach for them is already on their
  Connections page.
- **No promoting a quarantined package.** Fix what failed, or do not install it.
