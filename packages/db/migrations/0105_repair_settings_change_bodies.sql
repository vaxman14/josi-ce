-- Settings-change proposal bodies were written as JSON text cast to jsonb,
-- which stored them as JSON string scalars; the app then sent them on
-- double-encoded and the setting's route rejected them with a 400. Decode
-- the rows written that way; objects are untouched.
update settings_change_proposals
   set body = (body #>> '{}')::jsonb
 where jsonb_typeof(body) = 'string'
   and (body #>> '{}') ~ '^\s*[\[{]';
