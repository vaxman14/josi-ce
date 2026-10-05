insert into task_templates (key, name, contract, requires_capability) values
  ('restaurant_reservation', 'Restaurant reservation',
   '{"slots":{"required":["location","date_time","party_size"],"optional":["query","open_table_url","google_maps_url","booking_status","provider","restaurant_name","confirmation_code"]},"urgency_ceiling":"push","max_attempts":1}',
   'restaurant_handoff')
on conflict (key) do update set
  name = excluded.name,
  contract = excluded.contract,
  requires_capability = excluded.requires_capability,
  enabled = true;
