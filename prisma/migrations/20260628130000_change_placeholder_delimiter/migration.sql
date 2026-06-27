-- Changes the dynamic-value placeholder delimiter in saved node config from the
-- old `!#path#!` form to the new `@<path>@` form. Operates on Node.data (where
-- all user-authored references live). Idempotent: once converted, no `!#`/`#!`
-- remain, so the WHERE clause matches nothing on a re-run.
UPDATE "Node"
SET "data" = replace(replace("data"::text, '!#', '@<'), '#!', '>@')::jsonb
WHERE "data"::text LIKE '%!#%'
   OR "data"::text LIKE '%#!%';
