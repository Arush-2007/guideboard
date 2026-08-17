import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the other *.integration.test.ts files: the module graph reaches
// `@/lib/auth` -> `@/lib/email` -> `import "server-only"`, which throws under
// vitest. Nothing here exercises auth.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null } },
}));

import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import {
  insertStepResultOrReadExisting,
  loadStepResults,
  toStoredJson,
} from "./step-store";

/**
 * Proves the durable step store against a real Postgres. Typechecking can
 * establish none of this: the write is a hand-written CTE issued through
 * `$queryRaw`, so its parameter binding, its `jsonb` cast, its `ON CONFLICT`
 * target and the shape of what Prisma hands back are all behaviours of the
 * query engine rather than of the types.
 *
 * The property under test is the one the whole self-hosted runtime rests on: a
 * completed step never executes twice, and every writer for a key converges on
 * ONE value — so a resumed run cannot send a second email or append a duplicate
 * spreadsheet row.
 */

let executionId: string;
let otherExecutionId: string;

const write = (stepId: string, value: unknown, id = executionId) =>
  insertStepResultOrReadExisting({
    executionId: id,
    stepId,
    json: toStoredJson(stepId, value),
  });

async function newExecution(userId: string) {
  const workflow = await prisma.workflow.create({
    data: { name: "step store", userId },
    select: { id: true },
  });
  const execution = await prisma.execution.create({
    data: {
      workflowId: workflow.id,
      inngestEventId: `evt_${Date.now()}_${Math.random()}`,
    },
    select: { id: true },
  });
  return execution.id;
}

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  executionId = await newExecution(user.id);
  otherExecutionId = await newExecution(user.id);
});

afterAll(async () => {
  await cleanupDb();
});

describe("durable step store", () => {
  it("writes a value and reads it back through jsonb", async () => {
    // The `$queryRaw` CTE working at all is the thing to verify rather than
    // assume: a string parameter cast to `jsonb`, an `ON CONFLICT` on a
    // composite primary key, and a `UNION ALL` returning one row.
    expect(await write("node_a:http-request", { status: 200 })).toEqual({
      status: 200,
    });

    expect(await prisma.stepResult.count()).toBe(1);
    const stored = await prisma.stepResult.findUniqueOrThrow({
      where: {
        executionId_stepId: { executionId, stepId: "node_a:http-request" },
      },
    });
    expect(stored.value).toEqual({ status: 200 });
  });

  it("does not overwrite, and returns the FIRST stored value", async () => {
    expect(await write("node_a:plan", { row: 7 })).toEqual({ row: 7 });

    // A second attempt at the same step returns what is already stored, never
    // what this caller computed. That is what makes the store a memo rather
    // than a last-write-wins cache — and it is what stops a Sheets append from
    // re-deriving `nextFreeSheetRow` after its own write moved it.
    expect(await write("node_a:plan", { row: 99 })).toEqual({ row: 7 });

    expect(await prisma.stepResult.count()).toBe(1);
  });

  it("converges concurrent writers on one value", async () => {
    // If fencing ever fails and two processes run one execution, they must
    // agree rather than diverge. Some of these racers take the CTE's conflict
    // arm and some take the snapshot-race fallback; both return the stored row.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => write("node_a:race", { writer: i })),
    );

    expect(await prisma.stepResult.count()).toBe(1);
    const winner = await prisma.stepResult.findUniqueOrThrow({
      where: { executionId_stepId: { executionId, stepId: "node_a:race" } },
      select: { value: true },
    });
    // Every caller saw exactly the row that landed.
    for (const result of results) expect(result).toEqual(winner.value);
  });

  it("stores a null as a value, not as a missing row", async () => {
    // `StepResult.value` is a required Json column, so the query builder would
    // reject a bare `null` (SQL NULL) or `undefined` (omitted field) — the trap
    // `fan-out-store.ts` needs `Prisma.JsonNull` for. Binding jsonb directly
    // sidesteps it: `'null'::jsonb` is the JSON value null.
    expect(await write("node_a:nothing", undefined)).toBeNull();

    expect(await prisma.stepResult.count()).toBe(1);
    const loaded = await loadStepResults(executionId);
    // A hit whose value is null — distinguishable from never having run.
    expect(loaded.has("node_a:nothing")).toBe(true);
    expect(loaded.get("node_a:nothing")).toBeNull();
  });

  it("round-trips the values executors actually return", async () => {
    const iso = "2026-08-05T10:00:00.000Z";
    expect(
      await write("node_a:shapes", {
        at: new Date(iso),
        rows: [{ name: "a" }, { name: "b" }],
        matched: false,
        count: 0,
        missing: undefined,
        nested: { deep: { deeper: [1, 2, 3] } },
      }),
    ).toEqual({
      at: iso,
      rows: [{ name: "a" }, { name: "b" }],
      matched: false,
      count: 0,
      nested: { deep: { deeper: [1, 2, 3] } },
    });
  });

  it("loads a whole execution's steps in one query, and only its own", async () => {
    await write("node_a:one", 1);
    await write("node_b:two", { two: true });
    await write("nodes:0-4", "segment");
    await write("node_a:one", "belongs to the other run", otherExecutionId);

    const loaded = await loadStepResults(executionId);
    expect(loaded.size).toBe(3);
    expect(loaded.get("node_a:one")).toBe(1);
    expect(loaded.get("node_b:two")).toEqual({ two: true });
    expect(loaded.get("nodes:0-4")).toBe("segment");

    // Cross-execution bleed would be the per-node collision bug with a longer
    // blast radius, so the scoping is asserted rather than assumed.
    const other = await loadStepResults(otherExecutionId);
    expect(other.get("node_a:one")).toBe("belongs to the other run");
  });

  it("returns an empty map for a run that has never stored a step", async () => {
    // The fresh-run path: one query, zero rows, and no per-step SELECT after it.
    expect((await loadStepResults(executionId)).size).toBe(0);
  });

  it("keeps two nodes sharing a step literal separate", async () => {
    // The finding the key shape exists for, at the storage layer.
    expect(await write("node_a:get-credential", { key: "A" })).toEqual({
      key: "A",
    });
    expect(await write("node_b:get-credential", { key: "B" })).toEqual({
      key: "B",
    });

    const loaded = await loadStepResults(executionId);
    expect(loaded.get("node_a:get-credential")).toEqual({ key: "A" });
    expect(loaded.get("node_b:get-credential")).toEqual({ key: "B" });
  });

  it("is dropped with its execution, so retention pruning needs no new wiring", async () => {
    await write("node_a:one", 1);
    await write("node_b:two", 2);

    await prisma.execution.delete({ where: { id: executionId } });

    // Cascades from Execution, exactly as NodeInputSnapshot and FanOutSource do,
    // so `pruneOldExecutions` already collects these.
    expect(await prisma.stepResult.count({ where: { executionId } })).toBe(0);
    expect(await prisma.stepResult.count()).toBe(0);
  });
});
