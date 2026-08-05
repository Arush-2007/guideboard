import { NonRetriableError } from "inngest";
import prisma from "@/lib/db";

/**
 * Persistence half of the durable step: the memoized results of `step.run` and
 * `step.ai.wrap` for one execution. This is what replaces Inngest's memoization
 * when a workflow runs on the self-hosted worker.
 *
 * The contract in one sentence: **a completed step never executes twice.** That
 * is a correctness property, not a performance one — it is what stops a run
 * resumed after a crash, a redeploy or a lease reclaim from sending a second
 * email or appending a duplicate spreadsheet row.
 *
 * Split from `worker-step.ts` (which owns the step SEMANTICS — namespacing, the
 * collision counter, the fence check) so these two queries, the only place the
 * storage shape is known, can be exercised directly against a real Postgres in
 * `step-store.integration.test.ts`. Same split, and same reason, as
 * `fan-out-store.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE KEY IS PER-NODE — the single most important line in this file
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A stored step is keyed `(executionId, "<nodeId>:<the executor's own id>")`.
 * The `nodeId` prefix is REQUIRED, not tidiness.
 *
 * Executors use fixed string literals for step ids: `"get-credential"` appears
 * in four AI executors, and `"http-request"`, `"condition"`, `"switch"`,
 * `"slack-webhook"`, `"discord-webhook"` are each a single literal shared by
 * every node of that type. Two HTTP nodes, two Conditions or two Slack sends in
 * one workflow is ordinary workflow shape, not an edge case. Keyed on the bare
 * step id, the second node would be served the FIRST node's stored value — a
 * wrong-result bug that looks exactly like memoization working correctly.
 *
 * **Inngest has been masking this all along, and production is not wrong
 * today.** Its SDK SHA-1 hashes step ids and, on collision, appends
 * `STEP_INDEXING_SUFFIX + i` taking the first free index (verified in
 * `inngest/components/execution/v1.js:910-921`), emitting an
 * `AUTOMATIC_PARALLEL_INDEXING` warning whose own text admits the function "may
 * exhibit unexpected behaviour". So node 2 does get a distinct id and results
 * are correct — but that rests on an undocumented rescue, and it holds only
 * because this engine is strictly sequential, so call order is deterministic.
 *
 * **We deliberately do not copy that scheme.** Inngest resolves collisions per
 * RUN by EXECUTION ORDER; we resolve them per NODE by GRAPH POSITION. Position
 * is strictly more stable. Under Inngest's scheme, adding a node upstream that
 * happens to use the same literal renumbers every later one — `get-credential`
 * becomes `get-credential:1` — so a step id is not stable across an edit to a
 * completely different part of the workflow. Under `<nodeId>:<stepId>` it is.
 *
 * If you are about to "simplify" this key back to the bare step id: that is the
 * bug above, and it is silent.
 *
 * ⚠️ The primary key carries no iteration counter, so this table encodes "a node
 * runs at most once per execution" — the same constraint `NodeExecution` and
 * `NodeInputSnapshot` carry. A Tier 2 loops feature must add `sequence` to all
 * three, and this is the dangerous member of the set: the other two produce a
 * visibly wrong row, while a memoized step in iteration 2 would SILENTLY return
 * iteration 1's value. See the model comment in `prisma/schema.prisma`.
 */

/** One execution's memoized steps, by full step id. */
export type StepResultMap = Map<string, unknown>;

/**
 * Serializes a step's return value for storage, as a JSON string.
 *
 * Returns a string rather than a parsed value because the write below binds it
 * straight to a `jsonb` parameter — Postgres, not JS, performs the round trip
 * that gives callers `Jsonify<T>` semantics (see `insertStepResultOrReadExisting`).
 *
 * Two traps, both reachable from ordinary executor code:
 *
 * 1. **`JSON.stringify` returns `undefined`, not a string**, for `undefined`, a
 *    function or a symbol at the top level — and `JSON.parse(undefined)` then
 *    throws `SyntaxError: "undefined" is not valid JSON`. A step callback that
 *    returns nothing is completely normal, so this is not theoretical. It
 *    collapses to the JSON value `null`, which is also exactly what Inngest
 *    would have stored: `undefined` does not survive JSON either way.
 * 2. **`JSON.stringify` THROWS** on a BigInt and on a circular structure. Left
 *    alone, a raw `TypeError` escapes into the engine naming neither the step
 *    nor the node. `NonRetriableError` because no retry fixes a value that
 *    cannot be represented — the executor has to return something else.
 */
export function toStoredJson(stepId: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch (err) {
    throw new NonRetriableError(
      `Step "${stepId}" returned a value that cannot be stored as JSON: ` +
        `${err instanceof Error ? err.message : String(err)}. Step results are ` +
        `persisted so a resumed run does not re-execute them, so every value ` +
        `a step returns must survive JSON — BigInt and circular structures do not.`,
    );
  }
  // `undefined` from a top-level function/symbol/undefined — see trap 1.
  return json ?? "null";
}

/**
 * Loads every step already completed for this execution, in ONE query.
 *
 * Called lazily and at most once per run by `createWorkerStep`, which then
 * answers memoization hits from memory. This replaces a per-step `SELECT`, and
 * it is strictly cheaper on both paths:
 *
 * - **Fresh run** — a per-step SELECT is guaranteed to miss, every step,
 *   forever. Here it is one query returning zero rows, after which the whole
 *   read side of the store costs nothing.
 * - **Resume** — N queries become 1. This is the path the store exists for.
 *
 * The argument that actually decides it is pool pressure, not latency. The
 * worker's heartbeat must never be starved of a connection: if it cannot renew
 * the lease it fences ITSELF, a self-inflicted abort that looks like a mystery
 * (parent plan §6.3 hazard 1). Halving queries-per-step buys margin against the
 * failure mode that is hardest to diagnose.
 *
 * Safe as a cache because there is exactly ONE writer per execution — the
 * partial unique index `WorkflowJob_one_running_per_workflow` makes two RUNNING
 * jobs for a workflow physically impossible — and it lives for a single
 * attempt, since the worker calls `runWorkflowNodes` once rather than
 * re-entering a handler the way Inngest does. It can only ever be stale in the
 * direction of "I do not know about a row someone else wrote", and that path
 * ends in the conflict read below, which returns the STORED value.
 */
export async function loadStepResults(
  executionId: string,
): Promise<StepResultMap> {
  const rows = await prisma.stepResult.findMany({
    where: { executionId },
    select: { stepId: true, value: true },
  });

  // A Map, not an object: step ids are user-influenced (a node id joined to an
  // executor's literal), and a plain object would resolve `__proto__` and
  // `constructor` to inherited values instead of misses.
  return new Map(rows.map((row) => [row.stepId, row.value as unknown]));
}

/**
 * Writes a step's result, or returns the one already stored — in one statement.
 *
 * ```sql
 * WITH ins AS (INSERT ... ON CONFLICT DO NOTHING RETURNING value)
 * SELECT value FROM ins UNION ALL SELECT value FROM "StepResult" WHERE ... LIMIT 1
 * ```
 *
 * Two properties, and the shape is chosen because it gets both at once:
 *
 * 1. **It always returns THE STORED VALUE, never ours.** If fencing ever fails
 *    and two processes run one execution, they converge on a single answer
 *    instead of diverging. A cache in front of this must never be allowed to
 *    skip the read-back on conflict, or that convergence is quietly lost.
 * 2. **One round trip on both paths.** The insert and the conflict read are the
 *    same statement, so the happy path costs exactly one query and the conflict
 *    path costs no more.
 *
 * ⚠️ The returned value comes back THROUGH `jsonb`, which is what gives callers
 * Inngest's `Jsonify<T>` semantics on the FIRST execution and not only on
 * resume. That matters more than it looks: if a first run returned the raw `T`
 * and a resume returned a parsed value, a `Date` would be a `Date` on the happy
 * path and a string after a crash — green in every test, wrong only in
 * production, only after an incident. Routing both through Postgres makes them
 * byte-identical, which is stronger than a JS-side `JSON.parse(JSON.stringify())`
 * would be: `jsonb` also normalizes key order, so first-run and resumed values
 * cannot differ even in that.
 *
 * Note what is NOT needed here: `Prisma.JsonNull`. The query builder rejects a
 * bare `null` for a required `Json` column (it reads that as SQL NULL) and
 * `undefined` (as "omit this field"), which is why `fan-out-store.ts:49-63` has
 * to reach for the sentinel. Binding a `jsonb` parameter directly sidesteps the
 * whole problem: `"null"` is the JSON value null, a perfectly legal `jsonb`, and
 * distinct from SQL NULL.
 */
export async function insertStepResultOrReadExisting({
  executionId,
  stepId,
  json,
}: {
  executionId: string;
  stepId: string;
  /** From `toStoredJson`. */
  json: string;
}): Promise<unknown> {
  const rows = await prisma.$queryRaw<{ value: unknown }[]>`
    WITH ins AS (
      INSERT INTO "StepResult" ("executionId", "stepId", "value")
      VALUES (${executionId}, ${stepId}, ${json}::jsonb)
      ON CONFLICT ("executionId", "stepId") DO NOTHING
      RETURNING "value"
    )
    SELECT "value" FROM ins
    UNION ALL
    SELECT "value" FROM "StepResult"
      WHERE "executionId" = ${executionId} AND "stepId" = ${stepId}
    LIMIT 1
  `;

  if (rows.length > 0) return rows[0].value;

  // Reachable in exactly one race, and only under READ COMMITTED: a concurrent
  // transaction held an uncommitted row for this key, `ON CONFLICT DO NOTHING`
  // waited for it and then skipped — but the UNION arm reads from the snapshot
  // taken when the statement STARTED, which predates that commit, so it sees
  // nothing either. A second statement takes a fresh snapshot and resolves it.
  //
  // Costs a round trip only in the race, never on the ordinary paths.
  const existing = await prisma.stepResult.findUnique({
    where: { executionId_stepId: { executionId, stepId } },
    select: { value: true },
  });
  if (existing) return existing.value as unknown;

  // Unreachable by construction, and deliberately loud rather than silently
  // returning our own value. Either the INSERT wrote a row (the `ins` arm
  // returns it) or one already existed (an arm or the fallback finds it); a
  // missing parent execution raises a foreign-key error from the INSERT itself
  // rather than landing here. Getting here means an assumption above is wrong,
  // and the one thing that must not happen then is for a step to look memoized
  // while nothing was stored — the next resume would re-run its side effect.
  throw new NonRetriableError(
    `Step "${stepId}" of execution ${executionId} was neither stored nor found ` +
      `after writing it. The durable step store is in an unexpected state; this ` +
      `run cannot safely continue, because a step that is not stored will run ` +
      `again on resume.`,
  );
}
