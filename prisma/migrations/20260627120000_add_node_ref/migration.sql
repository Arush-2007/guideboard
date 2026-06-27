-- Adds the human-readable node reference key (e.g. "AI_TEXT_1") and backfills
-- it for existing per-node-output nodes, rewriting saved references so current
-- workflows keep resolving.

-- AlterTable
ALTER TABLE "Node" ADD COLUMN "ref" TEXT;

-- Backfill: assign a frozen, per-(workflow, type) sequential ref to the node
-- types whose executor writes its output under a per-node key. Triggers and
-- fixed-key nodes are intentionally left NULL (kept on their existing keys this
-- round). Ordered by createdAt so numbering follows creation order.
WITH numbered AS (
  SELECT
    id,
    type::text || '_' || ROW_NUMBER() OVER (
      PARTITION BY "workflowId", type
      ORDER BY "createdAt", id
    ) AS newref
  FROM "Node"
  WHERE type::text IN (
    'AI_TEXT', 'ANTHROPIC', 'DISCORD', 'GEMINI', 'GMAIL_ACTION',
    'GOOGLE_SHEETS_ACTION', 'HTTP_REQUEST', 'NOTION_ACTION', 'OPENAI',
    'SLACK', 'TELEGRAM_ACTION', 'WHATSAPP_ACTION'
  )
)
UPDATE "Node" n
SET "ref" = numbered.newref
FROM numbered
WHERE n.id = numbered.id;

-- Rewrite existing references in saved node data: the old context key was
-- `lower(type)_<cuid>`; replace each occurrence with the node's new ref so
-- `!#ai_text_<cuid>.output#!` becomes `!#AI_TEXT_1.output#!`. Cuids are globally
-- unique, so a plain text replace is unambiguous. Idempotent: re-running finds
-- no old keys to replace.
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

-- CreateIndex (matches @@unique([workflowId, ref]); NULLs are distinct in PG so
-- the many ref=NULL trigger rows don't collide).
CREATE UNIQUE INDEX "Node_workflowId_ref_key" ON "Node"("workflowId", "ref");
