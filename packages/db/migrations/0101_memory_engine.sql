-- Memory engine and self-improvement. Additive only.

-- Older parts of a long conversation, summarized so the beginning is not
-- forgotten when it falls outside the size budget. Notes, never instructions.
create table thread_summaries (
  thread_id uuid primary key references threads(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  summary text not null check (length(summary) between 1 and 6000),
  covered_through timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Recall searches the owner's own earlier messages.
create index messages_body_fts on messages using gin (to_tsvector('english', body));

-- What a turn was given: memories, recalled snippets, summary, skills,
-- rules and goals. Shown as "What Josi knew"; content is the owner's own.
create table turn_context (
  turn_id uuid primary key references assistant_turns(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  context jsonb not null,
  created_at timestamptz not null default now()
);

-- Evidence-backed observations: corrections, tool failures, things Josi
-- could not do, repeated tasks. Raw material for improvement proposals.
create table assistant_insights (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('correction', 'tool_failure', 'capability_gap', 'repeated_task', 'feedback')),
  summary text not null check (length(summary) between 1 and 600),
  evidence jsonb not null default '{}',
  thread_id uuid references threads(id) on delete set null,
  turn_id uuid references assistant_turns(id) on delete set null,
  proposal_id uuid,
  created_at timestamptz not null default now()
);
create index assistant_insights_open on assistant_insights (created_at) where proposal_id is null;

-- Proposed improvements. Josi proposes; only a super admin decides. Skills
-- and memory rules are applied on approval; a build brief is only recorded.
create table improvement_proposals (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 160),
  problem text not null check (length(problem) between 1 and 1500),
  change_kind text not null check (change_kind in ('skill', 'memory_rule', 'build_brief')),
  change jsonb not null,
  evidence jsonb not null default '[]',
  risk text not null default '' check (length(risk) <= 600),
  state text not null default 'proposed' check (state in ('proposed', 'approved', 'rejected', 'applied', 'rolled_back')),
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  announced_at timestamptz,
  created_at timestamptz not null default now()
);
alter table assistant_insights add constraint assistant_insights_proposal
  foreign key (proposal_id) references improvement_proposals(id) on delete set null;

-- Approved playbooks. Versioned: approving a change adds a version, rollback
-- reactivates the previous one. A skill can only name tools Josi already has.
create table assistant_skills (
  id uuid primary key default gen_random_uuid(),
  skill_key text not null check (skill_key ~ '^[a-z0-9-]{1,60}$'),
  version int not null check (version >= 1),
  name text not null check (length(name) between 1 and 120),
  when_to_use text not null check (length(when_to_use) between 1 and 600),
  steps text not null check (length(steps) between 1 and 4000),
  tools text[] not null default '{}',
  active boolean not null default true,
  proposal_id uuid references improvement_proposals(id) on delete set null,
  approved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (skill_key, version)
);
create unique index assistant_skills_one_active on assistant_skills (skill_key) where active;

-- Approved rules about what to remember and how to handle kinds of work.
create table memory_rules (
  id uuid primary key default gen_random_uuid(),
  rule text not null check (length(rule) between 1 and 600),
  active boolean not null default true,
  proposal_id uuid references improvement_proposals(id) on delete set null,
  approved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz
);
