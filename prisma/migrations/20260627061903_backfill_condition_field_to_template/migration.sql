-- Backfill for the Condition node's operand model change.
--
-- The Condition node's `field` used to be a bare context path (e.g.
-- `ai_text_abc.output`), resolved by a node-local path walker. It now uses the
-- same `!#path#!` templating syntax as every other field (the single
-- `renderTemplate` entry point): `!#path#!` is a reference, anything else is a
-- literal. Wrap any existing bare-path `field` values in `!#...#!` so they keep
-- resolving against the context. Values already containing a template marker
-- (`!#...#!` or `{{...}}`) and empty values are left untouched, which makes this
-- migration idempotent.
UPDATE "Node"
SET "data" = jsonb_set(
  "data",
  '{field}',
  to_jsonb('!#' || ("data" ->> 'field') || '#!')
)
WHERE "type"::text = 'CONDITION'
  AND "data" ? 'field'
  AND length(btrim("data" ->> 'field')) > 0
  AND ("data" ->> 'field') NOT LIKE '%!#%'
  AND ("data" ->> 'field') NOT LIKE '%{{%';
