-- Turns `Workflow.executionRuntime` from free text into an enum.
--
-- This is the column that decides which runtime executes a client's workflow,
-- and it is set BY HAND while workflows are migrated onto the self-hosted
-- worker. As `String?` a typo was silent: `SET "executionRuntime" = 'woker'`
-- did not match `'worker'`, so the row fell back to Inngest with no error
-- anywhere — indistinguishable from the routing switch not being deployed.
-- With an enum, Postgres rejects it outright. That is the whole point of this
-- migration; the column's behaviour is otherwise unchanged.
--
-- NULL still means Inngest and remains the default for every existing row, so
-- nothing moves runtime as a result of this. `INNGEST` exists as a member so a
-- workflow can be pinned deliberately once the default flips to the worker —
-- "never migrated" and "rolled back on purpose" are different facts.
--
-- The `USING` cast is safe because every existing value is NULL: verified on
-- 2026-08-06 against the development database (11 workflows, all NULL) and true
-- by construction everywhere else, since until this release no application code
-- read or wrote the column at all. Were a stray value present, the cast fails
-- loudly and this migration stops — which is the correct outcome for a column
-- whose whole problem was failing quietly.
--
-- Hand-written rather than produced by `prisma migrate dev`: this developer's
-- database carries `20260806120000_webhook_trigger_node_type` from another
-- branch, so `migrate dev` offered only to RESET it. Verified equivalent to the
-- schema with `prisma migrate diff --from-migrations ./prisma/migrations
-- --to-schema-datamodel ./prisma/schema.prisma`, which reports no difference.
CREATE TYPE "ExecutionRuntime" AS ENUM ('INNGEST', 'WORKER');

ALTER TABLE "Workflow"
  ALTER COLUMN "executionRuntime" TYPE "ExecutionRuntime"
  USING "executionRuntime"::"ExecutionRuntime";
