-- Josi CE 0037: the Skills library.
--
-- A SKILL IS A DOCUMENT, NOT A PROGRAM. It is a name, a publisher, a version
-- and a block of prose that says how to do a kind of work — "when somebody asks
-- for a weekly review, look at these things, in this order, and say it like
-- this". Josi reads it the way a new colleague reads a runbook.
--
-- WHY THIS IS A FIFTH THING AND NOT ANOTHER CONNECTION
--
-- 0034, 0035 and 0036 all answer the same question in three different ways:
-- what may Josi REACH, and with whose credential. This migration answers a
-- different question entirely — what may Josi be TOLD — and it is worth being
-- exact about the difference, because the temptation with a skills feature is
-- always to let it grow a capability of its own:
--
--   * A DEVELOPER SERVICE (0034) is a pasted token and a pinned host.
--   * A CUSTOM API (0035) is an administrator-written allowlist of requests.
--   * AN MCP SERVER (0036) is a remote party describing its own tools.
--   * A SKILL is TEXT. It has no credential, no host, no endpoint, no tool and
--     no execution path. There is no column in this migration that any request
--     is ever made from, and there is no code that turns a row here into a tool
--     the model may call.
--
-- THE ONE RULE THIS WHOLE MIGRATION EXISTS TO KEEP
--
--   A SKILL IS NEVER AN AUTHORITY BYPASS.
--
-- Everything a skill can do, the person it is working for could already have
-- asked for in their own words. `capabilities` below is a DECLARATION — what
-- the skill says it wants to use — and it grants nothing: at the moment of a
-- turn it is intersected with what THAT PERSON has actually connected and
-- switched on, and anything they lack is named to the model as unavailable
-- rather than quietly worked around. A skill cannot read a sealed credential
-- (there is no such column here and no code path that opens one for a skill),
-- cannot widen a scope (`connection_capabilities` is written by its owner and
-- by nobody else), and cannot approve a pending write (that decision has one
-- route and it requires a signed-in person).
--
-- SO THE DANGEROUS THING ABOUT A SKILL IS ITS PROSE, and this schema treats it
-- as exactly that: a block of somebody else's text that is about to be placed
-- near the model's own instructions. The controls follow from that reading and
-- from nothing else.
--
--   * INSTALLING IS NOT ACTIVATING. `skills.state` starts at 'review'. A row at
--     'review' is stored, readable and inert; nothing reaches a turn from it.
--   * ACTIVATION IS PINNED TO WHAT WAS READ. `reviewed_digest` is the hash of
--     the package somebody actually read, and the CHECK below refuses the
--     'enabled' state unless it equals `package_digest`. An updated skill has a
--     new digest, so an update CANNOT INHERIT AN ACTIVATION — it lands back at
--     'review' by arithmetic rather than by a code path remembering to.
--   * PACKAGES COME FROM A SOURCE SOMEBODY ADDED. `skills.source_id` is not
--     null. There is no route anywhere that takes a package body or a package
--     URL; installing names a source row and a key inside that source's index.
--   * WHAT FAILED A CHECK IS KEPT AS EVIDENCE, NOT AS A DRAFT. See
--     `skill_quarantine`, which deliberately has no instructions column.
--
-- THE OWNERSHIP DECISION, recorded here because the schema is what enforces it
--
-- INSTALLATION-SCOPED AND ADMINISTRATOR-OWNED, like 0035 and unlike 0034/0036,
-- and for a reason that is the mirror image of theirs. Those hold a credential
-- that ACTS AS A PERSON, so the person owns the row. A skill holds no
-- credential at all and acts as nobody; what it is, is a claim about how this
-- installation does its work, and reviewing that claim is an administrative act
-- in exactly the way reviewing a custom API endpoint is.
--
-- There is deliberately no `owner_user_id` anywhere in this migration, and so
-- no table here needs a cascade — nothing in it belongs to one person, and
-- deleting an account must not delete the workspace's runbook. Multi-user
-- isolation is preserved somewhere else and on purpose: an enabled skill is
-- read into EVERY member's turn, but what it can actually reach is resolved
-- per person at that moment, so two people with the same skill and different
-- connections get different, honest answers about what can be done.

-- ---------- where a package may come from ----------
--
-- THIS TABLE IS THE TRUST LIST. Not a convenience index of registries somebody
-- might use — the install route cannot name anything that is not a row here.
--
-- No credential column, and that is a decision rather than an omission. A
-- private registry needs a token; a token needs a store, a rotation story and
-- an owner; and an installer holding one would be a second credential broker
-- with none of those. CE fetches from registries that answer without one.
create table skill_sources (
  id uuid primary key default gen_random_uuid(),

  --   builtin     shipped inside this Josi release. No network, no URL. This is
  --               the curated starter catalogue, and it is METADATA AND
  --               PACKAGES SITTING IN THE SOURCE TREE — not an installed skill.
  --               Nothing from it is installed or enabled until somebody does
  --               both, deliberately, having read it.
  --   registry    a curated registry an administrator trusts and added.
  --   repository  one repository somebody supplied explicitly.
  -- The last two are fetched identically. They are distinguished because
  -- PROVENANCE IS SHOWN, and "a registry we chose to trust" and "a repository
  -- somebody pointed us at" are different sentences to read on a screen.
  kind text not null check (kind in ('builtin', 'registry', 'repository')),

  name text not null check (length(trim(name)) between 1 and 80),

  -- The index document. HTTPS ONLY at the database level as well as in the
  -- validator: a package fetched over plain http is a package any network
  -- between here and there may rewrite, and the digest that would catch that is
  -- carried in the same document.
  index_url text check (index_url is null or index_url ~ '^https://'),

  -- THE HOST ALLOWLIST, denormalised for the same reason 0035 and 0036 do it:
  -- every fetch re-parses the URL it is about to request and refuses unless the
  -- host matches this column exactly.
  host text check (host is null or (host = lower(host) and host not like '%/%')),

  -- The source's ed25519 signing key, raw and base64, when it publishes one.
  -- A source WITH a key means every package from it must be signed and verify;
  -- a source without one means signatures cannot be checked and packages say so
  -- on screen rather than being presented as verified.
  public_key text check (public_key is null or public_key ~ '^[A-Za-z0-9+/]{43}=$'),

  -- The built-in catalogue has no address and needs none; everything else must
  -- have both. Asserted rather than trusted, so a half-filled row cannot exist.
  constraint skill_sources_shape check (
    (kind = 'builtin' and index_url is null and host is null and public_key is null)
    or (kind <> 'builtin' and index_url is not null and host is not null)
  ),

  -- Switching a source off stops new installs and update checks from it. It
  -- does not disable what was installed: a skill already reviewed and switched
  -- on was reviewed on its own merits, and yanking it because a registry went
  -- quiet would be a surprise nobody asked for.
  enabled boolean not null default true,

  last_index_at timestamptz,
  last_index_ok boolean,
  -- A CATEGORY, never the registry's words. Same vocabulary as `ErrorCategory`
  -- in packages/connectors/src/providers.ts.
  last_error_category text check (last_error_category is null or last_error_category in (
    'revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'
  )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (name)
);
-- One built-in catalogue, ever. A second would mean two answers to "what ships
-- with Josi".
create unique index skill_sources_one_builtin on skill_sources (kind) where kind = 'builtin';
create unique index skill_sources_index_url on skill_sources (index_url) where index_url is not null;
create trigger skill_sources_touch before update on skill_sources
  for each row execute function touch_updated_at();

-- ---------- an installed skill ----------
--
-- Every row here is a package that PASSED every check. What failed one is in
-- `skill_quarantine` and is not in this table, so "is this trusted?" is not a
-- column anybody has to remember to consult — it is which table the row is in.
create table skills (
  id uuid primary key default gen_random_uuid(),

  -- `restrict`, not `cascade` and not `set null`. Removing a source that
  -- installed something would either destroy a reviewed skill or leave one with
  -- no provenance, and both are worse than being told to remove the skill
  -- first.
  source_id uuid not null references skill_sources(id) on delete restrict,

  -- PROVENANCE, denormalised on purpose. These three answer "where did this
  -- come from?" from the row itself, so the answer survives a source being
  -- renamed and does not depend on a join that a later query might forget.
  origin_kind text not null check (origin_kind in ('builtin', 'registry', 'repository')),
  origin_name text not null check (length(trim(origin_name)) between 1 and 80),
  origin_url text check (origin_url is null or origin_url ~ '^https://'),

  -- What the skill is called in the library, and what a dependency names.
  -- Constrained to an identifier so it can never carry a quote, a newline or a
  -- path into a screen, a log or a prompt.
  skill_key text not null check (skill_key ~ '^[a-z][a-z0-9_]{0,38}[a-z0-9]$'),

  -- The publisher's own words, all of them capped and stripped of control
  -- characters in code before they arrive. They are shown to people and read by
  -- the model, so they are pinned by `package_digest` rather than merely
  -- stored.
  name text not null check (length(trim(name)) between 1 and 80),
  version text not null check (version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  publisher text not null check (length(trim(publisher)) between 1 and 80),
  summary text not null default '' check (length(summary) <= 300),
  license text check (license is null or length(license) <= 60),
  homepage text check (homepage is null or homepage ~ '^https://'),

  -- THE SKILL ITSELF. Prose, capped, and the only reason every other column in
  -- this migration exists.
  instructions text not null check (length(instructions) between 1 and 16000),

  -- WHAT THE SKILL SAYS IT WANTS TO USE, and nothing more than that. Every
  -- entry is a key from a fixed vocabulary CE defines; a package naming
  -- anything else is quarantined rather than stored with a capability nobody
  -- can explain. THIS COLUMN GRANTS NOTHING: it is intersected at turn time
  -- with what the person being served has actually connected.
  capabilities jsonb not null default '[]',

  -- Other skills this one expects to be present, by key. Recorded and SHOWN,
  -- never auto-installed: an installer that pulls in packages nobody chose is
  -- how a reviewed library becomes an unreviewed one.
  dependencies jsonb not null default '[]',

  -- The hash of the canonical package — every field above, key-sorted, with the
  -- signature excluded. Canonical rather than byte-exact so that a registry
  -- reformatting its JSON does not look like a publisher changing their mind,
  -- and so that the digest changes exactly when something a person read
  -- changes.
  package_digest text not null check (package_digest ~ '^[0-9a-f]{64}$'),

  --   builtin     shipped inside this release; its integrity is the release's.
  --   verified    signed, and checked against the source's registered key.
  --   unverified  signed, but this source registered no key, so nothing could
  --               be checked. Said plainly rather than shown as a tick.
  --   unsigned    no signature. The digest pinned in the index and TLS to the
  --               pinned host are what is left, and the screen says so.
  signature_state text not null check (signature_state in (
    'builtin', 'verified', 'unverified', 'unsigned'
  )),
  signature_key_id text check (signature_key_id is null or length(signature_key_id) <= 80),

  --   review    installed, inert, waiting for somebody to read it.
  --   enabled   read, activated, and part of every turn.
  --   disabled  was activated, switched off. Still reviewed.
  state text not null default 'review' check (state in ('review', 'enabled', 'disabled')),

  -- THE DIGEST SOMEBODY ACTUALLY READ. Null until they have.
  reviewed_digest text check (reviewed_digest is null or reviewed_digest ~ '^[0-9a-f]{64}$'),

  -- REVIEW BEFORE ACTIVATION, ASSERTED BY THE DATABASE.
  --
  -- This one CHECK is the feature's central promise, and it is here rather than
  -- only in the code because it also makes the update path safe by arithmetic:
  -- an update writes a new `package_digest`, which no longer equals the old
  -- `reviewed_digest`, so the row CANNOT REMAIN 'enabled'. A future code path
  -- that forgot to send an updated skill back for review would not silently
  -- ship new instructions — it would fail to write at all.
  --
  -- `is not null` FIRST, and it is not redundant. A CHECK whose expression
  -- evaluates to NULL PASSES in PostgreSQL, so `state <> 'enabled' or
  -- reviewed_digest = package_digest` would be `false or null` — null, and
  -- therefore accepted — for exactly the row this constraint exists to refuse:
  -- one switched on having never been read. The test that writes that UPDATE
  -- by hand is what found it.
  constraint skills_enabled_was_reviewed check (
    state <> 'enabled'
    or (reviewed_digest is not null and reviewed_digest = package_digest)
  ),

  installed_at timestamptz not null default now(),
  activated_at timestamptz,
  last_update_check_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ONE MEANING PER KEY, installation-wide. Two skills called `weekly_review`
  -- from two publishers is the name-squatting attack this feature has, and it
  -- is refused here as well as in the conflict check that produces a sentence
  -- somebody can act on.
  unique (skill_key)
);
create index skills_active on skills (state);
create trigger skills_touch before update on skills
  for each row execute function touch_updated_at();

-- ---------- what happened to it ----------
--
-- The update history the library shows. Deliberately separate from `events`:
-- that is the installation-wide audit trail and is queried by kind, this is one
-- skill's own list and is rendered beside it. Both are written, because an
-- audit that can be deleted by removing the thing it audits is not an audit —
-- so this table cascades with its skill and `events` does not.
create table skill_history (
  id uuid primary key default gen_random_uuid(),

  -- WHAT PUTS THESE IN ORDER. `created_at` cannot: activating a skill records
  -- that it was read and that it was switched on, both inside the same second,
  -- and a uuid tie-breaks nothing — so the history rendered beside a skill came
  -- out in whichever order the planner felt like. A sequence is the only thing
  -- here that is actually monotonic.
  seq bigint generated always as identity,

  skill_id uuid not null references skills(id) on delete cascade,

  action text not null check (action in (
    'installed', 'updated', 'reviewed', 'enabled', 'disabled', 'update_checked'
  )),
  version text not null,
  package_digest text not null,
  signature_state text not null check (signature_state in (
    'builtin', 'verified', 'unverified', 'unsigned'
  )),
  origin_name text not null,

  -- `set null`: history outlives the administrator who made it. An installation
  -- that forgets who installed something because they left is an installation
  -- with a gap exactly where somebody would look.
  actor_user_id uuid references users(id) on delete set null,

  created_at timestamptz not null default now()
);
create index skill_history_recent on skill_history (skill_id, seq desc);

-- ---------- what did not pass ----------
--
-- A package CE refused to trust, kept so that "the install failed" is a fact
-- with a date and a reason rather than a toast somebody half remembers.
--
-- NO INSTRUCTIONS COLUMN, deliberately, and this is the most important line in
-- the table. The whole reason a package lands here is that something about it
-- could not be trusted — the digest did not match what the registry pinned, the
-- signature did not verify, or its prose was trying to talk the model out of
-- its own rules. Keeping that prose would mean storing untrusted text in a
-- table somebody eventually renders "just to see what it said". The key, the
-- version, the digest and the reason are the evidence; the text is not needed
-- for any of it and is dropped.
create table skill_quarantine (
  id uuid primary key default gen_random_uuid(),

  -- `set null`: a source can be removed while the record of what it served
  -- stays. `origin_name` below is what the screen reads from.
  source_id uuid references skill_sources(id) on delete set null,
  origin_name text not null check (length(trim(origin_name)) between 1 and 80),

  skill_key text not null check (length(trim(skill_key)) between 1 and 60),
  name text not null check (length(trim(name)) between 1 and 80),
  version text not null check (length(trim(version)) between 1 and 40),
  package_digest text check (package_digest is null or package_digest ~ '^[0-9a-f]{64}$'),

  --   schema_invalid         not the shape a package must have.
  --   digest_mismatch        not the package the index pinned.
  --   signature_missing      the source publishes a key and this was unsigned.
  --   signature_invalid      signed, and the signature did not verify.
  --   capability_unknown     asks for something CE has no such thing as.
  --   instruction_injection  its prose tries to override Josi's own rules.
  --   too_large              past a cap; not judged further.
  reason text not null check (reason in (
    'schema_invalid', 'digest_mismatch', 'signature_missing', 'signature_invalid',
    'capability_unknown', 'instruction_injection', 'too_large'
  )),
  -- CE'S OWN WORDS about which check failed — a field name, a capability key, a
  -- pattern label. Never a fragment of the package, which is the text that
  -- failed the check in the first place.
  detail text check (detail is null or length(detail) <= 300),

  created_at timestamptz not null default now()
);
create index skill_quarantine_recent on skill_quarantine (created_at desc);

-- The built-in catalogue. A ROW SAYING WHERE THE STARTER SKILLS COME FROM, and
-- not one skill installed: `skills` is empty on a fresh installation and stays
-- empty until an administrator installs something and then activates it.
insert into skill_sources (kind, name)
values ('builtin', 'Josi starter skills')
on conflict do nothing;

-- Defence in depth, matching every other table in this schema. CE connects as
-- the owning role so these do not gate the application; they mean that a
-- second, less-privileged role added later starts from deny.
alter table skill_sources enable row level security;
alter table skills enable row level security;
alter table skill_history enable row level security;
alter table skill_quarantine enable row level security;
