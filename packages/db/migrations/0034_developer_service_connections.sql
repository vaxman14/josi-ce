-- Josi CE 0034: developer and deployment service connections.
--
-- GitHub, Netlify, Vercel and Supabase. Four services with one thing in common
-- that makes them unlike everything else CE already connects to: the credential
-- is a PERSONAL ACCESS TOKEN the person mints in their own account and pastes
-- here. There is no OAuth handshake to constrain it, no provider consent screen
-- naming what it covers, and — for three of the four — no scope vocabulary the
-- provider will echo back. Whatever the person pasted is what CE holds.
--
-- THE OWNERSHIP DECISION, recorded here because the schema is what enforces it
--
-- These are USER-SCOPED, not installation-admin services.
--
-- A GitHub PAT acts as its holder: commits, issues and reviews carry that
-- person's name. A Netlify or Vercel token deploys to that person's own team.
-- A Supabase personal access token administers that person's own projects.
-- None of them is installation plumbing the way an SMTP profile or an OAuth
-- client registration is — those are one thing the operator configures for
-- everybody, and this is somebody's own account acting as them.
--
-- So `owner_user_id` is on the row and there is no installation-wide variant of
-- this table, which is the same shape `connections` has and for the same reason
-- (see packages/core/src/ownership.ts). The administrator's authority over it is
-- exactly the authority they have over an OAuth connection: they can see that
-- one exists and whether it works, they can cut it off, and they can forbid a
-- service installation-wide from `developer_service_policy` below. They cannot
-- read it, and there is no column here that would let them.
--
-- WHAT IS NOT IN THIS TABLE
--
-- The token, in any readable form. `credentials_enc` is sealed with the
-- installation master key (packages/core/src/sealing.ts) before it is ever
-- passed to a query, so a database dump alone yields nothing usable. No column
-- holds a prefix, a suffix, a length or a hash of it either: the Connections
-- page shows a fixed mask, because "the last four characters" is still four
-- characters of a credential and answers no question the account label does not
-- already answer better.

create table developer_service_connections (
  id uuid primary key default gen_random_uuid(),

  -- The person. `on delete cascade` because a deleted account's tokens must go
  -- with it — a token that outlives its owner is a credential nobody is
  -- responsible for.
  owner_user_id uuid not null references users(id) on delete cascade,

  service text not null check (service in ('github', 'netlify', 'vercel', 'supabase')),

  -- Sealed. See the note above; nothing reads this except the probe, at the
  -- moment of use.
  credentials_enc text not null,

  -- What the provider said this token belongs to, learned from its own identity
  -- call rather than typed by the person. A pasted-wrong token is then caught
  -- at setup instead of at the first deploy. This is the account's own public
  -- handle (`login`, `slug`, `username`) — the same class of fact as a Telegram
  -- @username, and shown only to its owner.
  account_label text,
  account_id text,

  -- Only GitHub reports what a token actually covers (`x-oauth-scopes`), and
  -- only for classic tokens. Stored when offered so the page can show the
  -- person what they granted against what the service needs; null everywhere
  -- else, and the UI says "this provider does not report scopes" rather than
  -- implying an empty list means no access.
  reported_scopes text,

  -- Supabase only: which project this token is being used against, so the
  -- page can name it. A project ref is a public identifier that appears in the
  -- project's own URL — it is not a credential, and it is not accepted in any
  -- other shape (see the CHECK: 20 lowercase letters, exactly what Supabase
  -- issues) so nothing that looks like a URL, a path or a host can be stored
  -- here and later interpolated into a request.
  project_ref text check (project_ref is null or project_ref ~ '^[a-z]{20}$'),

  -- The same three states `connections` uses, deliberately, so one vocabulary
  -- covers both surfaces:
  --   active          — the last check succeeded
  --   needs_reconnect — the provider refused the credential; a new one is needed
  --   revoked         — cut off here, by the owner or an administrator
  status text not null default 'active' check (status in ('active', 'needs_reconnect', 'revoked')),

  last_check_at timestamptz,
  last_check_ok boolean,
  -- A CATEGORY, never the provider's words. GitHub and Supabase both quote the
  -- offending request back in some failure bodies, and a request carrying an
  -- Authorization header quotes a token. The values are exactly
  -- `ErrorCategory` in packages/connectors/src/providers.ts so the existing
  -- plain-language vocabulary covers this screen too.
  last_error_category text check (last_error_category is null or last_error_category in (
    'revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'
  )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One connection per person per service. A second one would make "which
  -- token does Josi use?" a question with no answer.
  unique (owner_user_id, service)
);
create index developer_service_connections_owner
  on developer_service_connections (owner_user_id, service);
create trigger developer_service_connections_touch before update on developer_service_connections
  for each row execute function touch_updated_at();

-- ---------- the administrator's ceiling ----------
--
-- Deny-only, the same shape as `admin_capability_policy` and for the same
-- reason: there is no column here an administrator can set that turns a
-- connection ON for somebody. `allowed` starts true, which is not "on" — it is
-- "not forbidden". Every connection still begins with a person pasting their
-- own token.
create table developer_service_policy (
  service text primary key check (service in ('github', 'netlify', 'vercel', 'supabase')),
  allowed boolean not null default true,
  -- Shown to the person whose connection this forbids, so the refusal has a
  -- reason attached rather than looking like a bug.
  note text,
  updated_at timestamptz not null default now()
);
insert into developer_service_policy (service)
  values ('github'), ('netlify'), ('vercel'), ('supabase')
  on conflict do nothing;
create trigger developer_service_policy_touch before update on developer_service_policy
  for each row execute function touch_updated_at();

-- Defence in depth, matching every other credential-bearing table in this
-- schema. CE connects as the owning role so these do not gate the application;
-- they mean that a second, less-privileged role added later starts from deny.
alter table developer_service_connections enable row level security;
alter table developer_service_policy enable row level security;
