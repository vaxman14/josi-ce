-- Insight and proposal evidence was written through JSON.stringify as a text
-- parameter, which jsonb stores as a JSON string scalar ("{\"tool\":...}").
-- jsonb_set and jsonb_array_length then fail on it (the Improvements page
-- returned "cannot get array length of a scalar"). Decode the rows written
-- that way; rows already holding an object or array are untouched.
update assistant_insights
   set evidence = (evidence #>> '{}')::jsonb
 where jsonb_typeof(evidence) = 'string'
   and (evidence #>> '{}') ~ '^\s*[\[{]';

update improvement_proposals
   set evidence = (evidence #>> '{}')::jsonb
 where jsonb_typeof(evidence) = 'string'
   and (evidence #>> '{}') ~ '^\s*[\[{]';

update improvement_proposals
   set change = (change #>> '{}')::jsonb
 where jsonb_typeof(change) = 'string'
   and (change #>> '{}') ~ '^\s*[\[{]';
