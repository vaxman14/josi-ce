-- "My World": everything about a person, in the Vault, fed by chat
-- (docs/JOSI_IS_THE_INTERFACE.md rule 8).
--
-- An item is a thing in the person's life: a family member, an address, a
-- vehicle, a home, a passport, a card, an account. Its non-secret facts live
-- in `fields` and `dates` in the clear, so Josi can be useful about them. Its
-- secret fields (numbers, VINs, plates, PINs) live only in `secrets_enc`,
-- sealed with the owner's own Vault box key, shown only on the My World page
-- behind the person's password, never in a conversation.
create table my_world_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('person','address','vehicle','property','document','card','account','other')),
  label text not null check (length(label) between 1 and 160),
  fields jsonb not null default '{}',
  dates jsonb not null default '{}',
  -- Which field keys are secret for this item. Starts from the kind's
  -- defaults; the person can widen or narrow it.
  secret_keys text[] not null default '{}',
  secrets_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index my_world_items_owner on my_world_items (owner_user_id, kind);
create trigger my_world_items_touch before update on my_world_items
  for each row execute function touch_updated_at();

-- What Josi knows, as she learned it: its own store, written only by the My
-- World flows and read on every turn. The general memory engine never reads
-- or writes it, so a model mistake there cannot alter or delete a World fact.
create table my_world_memory (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  item_id uuid references my_world_items(id) on delete cascade,
  content text not null check (length(content) between 1 and 600),
  -- 'item' lines are rebuilt from the item each time it changes; 'chat' and
  -- 'page' lines are the person's or Josi's own words and stay as written.
  source text not null default 'chat' check (source in ('item','chat','page')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index my_world_memory_owner on my_world_memory (owner_user_id, created_at);
create trigger my_world_memory_touch before update on my_world_memory
  for each row execute function touch_updated_at();
