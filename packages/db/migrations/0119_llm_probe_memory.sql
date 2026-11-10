-- What the capability check found for each model this server has tried, so
-- switching back to a model checked before is instant: the result is applied
-- to the slot and the model is active at once. A model never checked here
-- still gets its one real check.
create table if not exists llm_probe_memory (
  provider text not null,
  model text not null,
  base_url text not null default '',
  probed_at timestamptz not null,
  probe_steps jsonb not null default '[]',
  cap_chat boolean,
  cap_structured_output boolean,
  cap_tool_calling boolean,
  cap_vision boolean,
  cap_context_tokens integer,
  primary key (provider, model, base_url)
);
