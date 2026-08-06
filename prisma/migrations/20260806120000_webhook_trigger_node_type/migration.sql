-- Give WebhookTrigger a nodeType, so one table can serve every
-- token-authenticated webhook rather than one near-identical table per provider.
--
-- Ordering matters: the column lands with a DEFAULT first, so every existing row
-- is already labelled WEBHOOK_TRIGGER by the time the old constraint is dropped
-- and the composite one is added. No row is ever unlabelled, and no window
-- exists in which two rows could collide.

-- 1. Label existing rows. They are all generic webhooks by construction — until
--    now the table held nothing else — so the default restates what they are.
ALTER TABLE "WebhookTrigger"
  ADD COLUMN "nodeType" "NodeType" NOT NULL DEFAULT 'WEBHOOK_TRIGGER';

-- 2. Drop the single-column constraint. It encoded "a workflow has at most one
--    webhook", which a second token-authenticated trigger type makes false.
DROP INDEX IF EXISTS "WebhookTrigger_workflowId_key";

-- 3. One row per (workflow, trigger type). Safe to add without a uniqueness
--    check of our own: step 1 gave every pre-existing row the same nodeType, and
--    workflowId was unique among them a moment ago, so the pair is unique too.
CREATE UNIQUE INDEX "WebhookTrigger_workflowId_nodeType_key"
  ON "WebhookTrigger"("workflowId", "nodeType");
