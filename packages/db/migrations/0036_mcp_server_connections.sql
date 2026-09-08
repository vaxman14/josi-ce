-- Josi CE 0036: external MCP server connections.
--
-- A person points Josi at a remote MCP server they already use — their notes
-- app, their issue tracker, their own service — and Josi asks that server what
-- tools it offers. Each tool is then reviewed and switched on ONE AT A TIME
-- before the assistant is ever told it exists.
--
-- WHY THIS IS A FOURTH THING AND NOT A COLUMN ON ONE OF THE OTHER THREE
--
-- CE already has three shapes of outbound connection, and it is worth being
-- exact about why this is none of them:
--
--   * A DEVELOPER SERVICE (0034) has ONE PINNED HOST compiled into CE and four
--     hand-written probes. Nothing about it is user-supplied and the assistant
--     gains no tool at all.
--   * A CUSTOM API (0035) has an operator-supplied host and an allowlist an
--     ADMINISTRATOR writes by hand, one HTTP request per row. The product knows
--     what each row does because a person typed it.
--   * A MODEL ENDPOINT (llm_providers) is one caller asking one question with
--     one shape.
--
-- 0034 and 0035 both say, correctly for when they were written, that MCP
-- servers are not implemented in CE. This migration is what changes that, and
-- neither of those comments is edited: an applied migration is a historical
-- record, and the living documents (docs/DEVELOPER_SERVICE_CONNECTIONS.md,
-- docs/CUSTOM_API_CONNECTIONS.md, packages/connectors/src/customApi.ts) carry
-- the correction instead.
--
-- Here the far end SPEAKS A PROTOCOL and DESCRIBES ITSELF. The allowlist is not
-- typed by anybody: it is discovered, and every word in it — the tool's name,
-- its description, its input schema — is text a remote server chose. That is
-- the whole difference, and everything below follows from it:
--
--   * A DISCOVERED TOOL IS NOT AN ALLOWED TOOL. `mcp_server_tools.state` starts
--     at 'new'. Discovery writes rows; it grants nothing.
--   * WHAT WAS APPROVED IS PINNED. `definition_digest` is a hash of the name,
--     description and input schema that the owner actually read. A server that
--     changes any of them after approval finds its tool moved to 'changed' and
--     switched off, because a tool whose description became "also emails your
--     contacts" is not the tool anybody agreed to.
--   * NOTHING THE SERVER SAYS ABOUT ITSELF IS TRUSTED AS A PERMISSION. MCP lets
--     a server annotate a tool `readOnlyHint`. That is the server's opinion of
--     its own safety and it is stored as `server_read_only_hint` — a claim,
--     shown to the owner, never a column any code branches on to skip an
--     approval. `approval_mode` is the owner's answer, and it defaults to
--     'ask'.
--
-- THE OWNERSHIP DECISION, recorded here because the schema is what enforces it
--
-- USER-SCOPED, like 0034 and unlike 0035, and for the reason ownership.ts
-- gives: a credential that acts as a person belongs to that person. An MCP
-- server's token is somebody's own account at their own notes app or issue
-- tracker; a shared installation-wide one would mean every member reading and
-- writing as one person. So `owner_user_id` is on the row, `on delete cascade`
-- with the account, and there is no installation-wide variant of this table.
--
-- The administrator's authority is exactly what it is over an OAuth connection
-- and a developer service: see that one exists and whether it works, cut one
-- off, and forbid the feature installation-wide from `mcp_policy`. They cannot
-- read a credential, see which tools somebody approved, or connect a server for
-- somebody else. There is no column here that would let them.
--
-- WHAT IS NOT IN THESE TABLES
--
-- The credential, in any readable form. `credentials_enc` is sealed with the
-- installation master key (packages/core/src/sealing.ts) before it reaches a
-- query, and no column holds a prefix, a suffix, a length or a hash of it.
--
-- The server's `instructions` field, deliberately. MCP lets a server return a
-- block of prose intended to be placed in the model's system prompt. Storing it
-- would hand a remote party a writable region of Josi's own instructions, which
-- is the clearest prompt-injection channel the protocol offers. CE reads the
-- field and drops it.

-- ---------- the server ----------

create table mcp_servers (
  id uuid primary key default gen_random_uuid(),

  -- WHOSE. `cascade` because a server credential that outlives its owner is a
  -- live token nobody is responsible for.
  owner_user_id uuid not null references users(id) on delete cascade,

  -- What its owner sees. Free text, never interpolated into a request.
  name text not null check (length(trim(name)) between 1 and 80),

  -- What the MODEL sees, and the first half of every tool call it can form.
  -- Constrained to an identifier so a name can never carry a path, a host, a
  -- quote or a newline into a prompt.
  slug text not null check (slug ~ '^[a-z][a-z0-9_]{0,38}[a-z0-9]$'),

  -- The Streamable HTTP endpoint. HTTPS ONLY, at the database level as well as
  -- in the validator: an MCP session carries this person's token in a header on
  -- every request, and "they typed it, so they meant it" is not a defence for
  -- putting somebody's credential on the wire in clear text.
  --
  -- There is no stdio variant and there will not be one. A stdio MCP server is
  -- a command line CE would execute inside its own container; that is remote
  -- code execution offered as a text field, and no amount of validation makes
  -- it into a connection.
  endpoint_url text not null check (endpoint_url ~ '^https://'),

  -- THE HOST ALLOWLIST, denormalised deliberately — the same invariant 0035
  -- states, for the same reason. It is derivable from `endpoint_url` and it is
  -- stored anyway, because every request re-parses the URL it is about to make
  -- and refuses unless the host matches this column exactly.
  host text not null check (host = lower(host) and host not like '%/%'),

  -- Bearer token, API key in a named header, or nothing.
  --
  -- 'none' is offered here and refused in 0035, which is a difference worth
  -- stating rather than leaving as an inconsistency. There, the credential IS
  -- the connection: an unauthenticated custom API row would be a general
  -- outbound HTTP capability with extra steps, because the row itself is what
  -- names a request. Here, an unauthenticated public MCP server is an ordinary
  -- thing that exists, and refusing it would not narrow what Josi can reach by
  -- one byte — the bound is the pinned host, the public-internet address check,
  -- the refusal to follow redirects, and the fact that the model names a tool
  -- rather than a URL. Those apply identically with or without a token.
  --
  -- There is no 'oauth'. CE's OAuth machinery is built around a registered
  -- client, a provider consent screen and a refresh cycle, none of which an
  -- arbitrary MCP server supplies, and a value that said 'oauth' while the code
  -- pasted a long-lived token into a header would be a lie told in schema.
  auth_kind text not null default 'none' check (auth_kind in ('none', 'bearer', 'api_key')),

  -- `api_key` only: which header carries it. A header NAME, checked against the
  -- RFC 7230 token grammar, so nothing here can inject a second header or a
  -- request line.
  auth_header text check (auth_header is null or auth_header ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'),

  -- Sealed `{ secret }`, or null when there is nothing to seal. The pairing is
  -- enforced rather than trusted: a row claiming bearer authentication with no
  -- credential would fail at request time with a message nobody could explain.
  credentials_enc text,
  constraint mcp_servers_credential_matches_auth check (
    (auth_kind = 'none' and credentials_enc is null and auth_header is null)
    or (auth_kind = 'bearer' and credentials_enc is not null and auth_header is null)
    or (auth_kind = 'api_key' and credentials_enc is not null and auth_header is not null)
  ),

  -- LEAST PRIVILEGE, TWICE. `enabled` starts false and the route that sets it
  -- true refuses unless the server has actually answered a handshake. Every
  -- tool under it starts at 'new' and is separately approved. So nothing
  -- reaches the assistant on the strength of a form somebody filled in.
  enabled boolean not null default false,

  status text not null default 'unverified' check (status in ('unverified', 'active', 'needs_attention')),
  last_check_at timestamptz,
  last_check_ok boolean,
  -- A CATEGORY, never the server's words. An MCP server's error text is
  -- attacker-influenced and may quote the request back — and a request here
  -- carries an Authorization header. The values are exactly `ErrorCategory` in
  -- packages/connectors/src/providers.ts.
  last_error_category text check (last_error_category is null or last_error_category in (
    'revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'
  )),

  -- What the handshake reported, kept so the page can show the owner they are
  -- talking to what they think they are talking to. All three are the remote
  -- server's own words: length-capped here and stripped of control characters
  -- in code before they are stored, because they end up on a screen.
  protocol_version text check (protocol_version is null or length(protocol_version) <= 40),
  server_label text check (server_label is null or length(server_label) <= 120),

  -- When Josi last asked "what tools do you have?". Separate from
  -- `last_check_at` because a handshake and a tool list are different claims,
  -- and "connected fine, has not been re-listed in a month" is a real state.
  last_discovery_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One meaning per short name per person. Two servers called `notes` would
  -- make "which one did Josi call?" a question with no answer. Scoped to the
  -- owner, not global: one person's naming choices are not another's problem.
  unique (owner_user_id, slug)
);
create index mcp_servers_owner on mcp_servers (owner_user_id, enabled);
create trigger mcp_servers_touch before update on mcp_servers
  for each row execute function touch_updated_at();

-- ---------- the allowlist ----------
--
-- The whole point of this migration. There is no row anywhere that means "any
-- tool on this server", and no code path that composes one.
create table mcp_server_tools (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references mcp_servers(id) on delete cascade,

  -- The name the server gave it, which is also what the model names when it
  -- asks for this tool. Constrained to the characters MCP tool names actually
  -- use, so a "tool name" cannot carry a newline, a quote or a brace into a
  -- prompt or a JSON-RPC frame.
  tool_name text not null check (tool_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),

  -- The server's own words about itself, capped. These are shown to the owner
  -- and given to the model, so they are the highest-value prompt-injection
  -- surface this feature has — which is exactly why they are pinned by
  -- `definition_digest` below rather than merely stored.
  title text check (title is null or length(title) <= 200),
  description text not null default '' check (length(description) <= 2000),

  -- The tool's declared inputs, as the server sent them. Passed to the model as
  -- a parameter schema and used to bound what may be sent; never executed and
  -- never interpolated.
  input_schema jsonb not null default '{}',

  -- The server's OPINION of its own safety (`annotations.readOnlyHint`). A
  -- claim, shown to the owner as one. Null means it said nothing. Nothing
  -- branches on this to skip an approval — a server that could mark its own
  -- tools safe would be a server that grants itself permissions.
  server_read_only_hint boolean,

  -- WHAT THE OWNER ACTUALLY READ, hashed. Name, title, description and input
  -- schema. Discovery compares against it, and a difference on an approved tool
  -- moves it to 'changed' and takes it off the allowlist.
  definition_digest text not null,

  --   new       discovered, never decided. Not offered.
  --   approved  on the allowlist. Offered when the server is enabled too.
  --   revoked   the owner said no. Re-discovery does not ask again.
  --   changed   was approved; the server changed the definition. Off until the
  --             owner reads the new one.
  state text not null default 'new' check (state in ('new', 'approved', 'revoked', 'changed')),

  -- What happens when the assistant calls it. The OWNER's answer, not the
  -- server's: 'ask' turns every call into a request they see in full and
  -- decide, 'auto' lets it run. It defaults to 'ask' because the safe default
  -- for a tool nobody here wrote is that somebody looks at it.
  approval_mode text not null default 'ask' check (approval_mode in ('ask', 'auto')),

  -- Whether the last discovery still saw it. A tool the server stopped offering
  -- is kept rather than deleted, so the owner's decision about it survives the
  -- server being briefly unreachable — but it is not offered.
  available boolean not null default true,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  decided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (server_id, tool_name)
);
create index mcp_server_tools_offered on mcp_server_tools (server_id, state, available);
create trigger mcp_server_tools_touch before update on mcp_server_tools
  for each row execute function touch_updated_at();

-- ---------- the approval gate ----------
--
-- Same mechanism as `custom_api_pending_calls` and deliberately its own table:
-- that one is keyed to an endpoint row an administrator wrote, this one to a
-- tool a remote server described, and a foreign key cannot point at both.
--
-- The decision and the call are one route and one conditional UPDATE, so an
-- approved call can neither sit unmade nor be made twice.
create table mcp_pending_calls (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null references users(id) on delete cascade,
  tool_id uuid not null references mcp_server_tools(id) on delete cascade,
  thread_id uuid references threads(id) on delete cascade,

  -- What would happen, in words, written from the ALLOWLIST ROW and the
  -- arguments rather than from anything the model said about them. CONTENT: it
  -- quotes what is about to be sent, so it is its owner's and never reaches an
  -- audit payload.
  summary text not null check (length(trim(summary)) between 1 and 2000),

  -- The exact arguments, SEALED. Not a jsonb column: arguments on the way to
  -- somebody's notes app are their data and have no business being readable in
  -- a database dump while they wait for an answer.
  request_enc text not null,

  -- Pins the approval to this exact call (packages/core/src/approvals.ts,
  -- `approvalHash`). An approval that does not pin the payload is a rubber
  -- stamp.
  payload_hash text not null,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
  decided_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  executed_at timestamptz,
  -- Whether the server accepted it. A boolean, never its answer.
  result_ok boolean,

  expires_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mcp_pending_calls_owner
  on mcp_pending_calls (owner_user_id, status, created_at desc);
create unique index mcp_pending_calls_one_pending
  on mcp_pending_calls (owner_user_id, tool_id, payload_hash)
  where status = 'pending';
create trigger mcp_pending_calls_touch before update on mcp_pending_calls
  for each row execute function touch_updated_at();

-- ---------- the administrator's ceiling ----------
--
-- Deny-only by construction, the same shape as `developer_service_policy`.
-- `allowed` starts true, which is not "on" — it is "not forbidden". Every
-- connection still begins with a person adding their own server, and there is
-- no column here an administrator can set that connects one for somebody.
--
-- `allowed_hosts` narrows and never widens: empty means "no host restriction
-- beyond the public-internet rule", and a non-empty list refuses everything
-- outside it. An operator who needs Josi to reach exactly two vendors can say
-- so; one who does not, does nothing.
create table mcp_policy (
  id boolean primary key default true check (id),
  allowed boolean not null default true,
  -- Shown to the person whose connection this forbids, so the refusal has a
  -- reason attached rather than looking like a bug.
  note text check (note is null or length(note) <= 300),
  allowed_hosts jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
insert into mcp_policy (id) values (true) on conflict do nothing;
create trigger mcp_policy_touch before update on mcp_policy
  for each row execute function touch_updated_at();

-- Defence in depth, matching every other credential-bearing table in this
-- schema. CE connects as the owning role so these do not gate the application;
-- they mean that a second, less-privileged role added later starts from deny.
alter table mcp_servers enable row level security;
alter table mcp_server_tools enable row level security;
alter table mcp_pending_calls enable row level security;
alter table mcp_policy enable row level security;
