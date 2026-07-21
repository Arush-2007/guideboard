-- An idempotency key names an EXTERNAL EVENT (`gmail:<messageId>`,
-- `google_sheets:<sheetId>:<row>:…`), so a global unique made two workflows
-- watching the same source compete for one key: the first poll to land created
-- the Execution and the second workflow's run was silently dropped as a
-- duplicate. Scope the uniqueness to the workflow instead.
--
-- Safe on existing data: the dropped index guaranteed keys were globally
-- unique, so no two rows can collide on the narrower (workflowId, key) pair.

-- DropIndex
DROP INDEX "Execution_idempotencyKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Execution_workflowId_idempotencyKey_key" ON "Execution"("workflowId", "idempotencyKey");
