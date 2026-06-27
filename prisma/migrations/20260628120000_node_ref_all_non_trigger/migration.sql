-- Extends node refs to EVERY non-trigger node (Condition, AI Reply Generator,
-- reply nodes, etc.), not just the per-node-output ones. Backfills refs for
-- existing nodes that don't have one yet, then rewrites any legacy
-- `<type>_<id>` references in saved data to the new refs.

-- Backfill: assign a frozen, per-(workflow, type) sequential ref to every
-- ref-less node whose type is NOT a trigger / the INITIAL placeholder.
WITH numbered AS (
  SELECT
    id,
    type::text || '_' || ROW_NUMBER() OVER (
      PARTITION BY "workflowId", type
      ORDER BY "createdAt", id
    ) AS newref
  FROM "Node"
  WHERE "ref" IS NULL
    AND type::text NOT IN (
      'INITIAL', 'MANUAL_TRIGGER', 'GOOGLE_FORM_TRIGGER', 'TYPEFORM_TRIGGER',
      'GMAIL_TRIGGER', 'GOOGLE_SHEETS_TRIGGER', 'SCHEDULE_TRIGGER',
      'WEBHOOK_TRIGGER', 'INSTAGRAM_COMMENT_TRIGGER', 'YOUTUBE_COMMENT_TRIGGER',
      'TELEGRAM_TRIGGER'
    )
)
UPDATE "Node" n
SET "ref" = numbered.newref
FROM numbered
WHERE n.id = numbered.id;

-- Rewrite legacy `lower(type)_<cuid>` references in saved node data to the
-- node's ref. Idempotent (already-rewritten refs find no legacy key to match)
-- and safe to run over all reffed nodes.
DO $$
DECLARE
  src RECORD;
BEGIN
  FOR src IN
    SELECT id, "workflowId", type, "ref" FROM "Node" WHERE "ref" IS NOT NULL
  LOOP
    UPDATE "Node" t
    SET "data" = replace(
      t."data"::text,
      lower(src.type::text) || '_' || src.id,
      src."ref"
    )::jsonb
    WHERE t."workflowId" = src."workflowId"
      AND t."data"::text LIKE '%' || lower(src.type::text) || '_' || src.id || '%';
  END LOOP;
END $$;
