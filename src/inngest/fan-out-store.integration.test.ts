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
import type { FanOutChain } from "./fan-out";
import { planFanOutChain } from "./fan-out";
import { readFanOutSource, storeFanOutSource } from "./fan-out-store";

/**
 * Proves the fan-out storage round-trip against a real Postgres: the parent
 * writes a chain's payload once, and each child reads back exactly its own
 * item. Typechecking cannot establish either half — the nested `createMany`
 * and the nested `where: { index }` select are behaviours of the query engine,
 * not of the types.
 *
 * This is the pairing that makes a chain link a fixed-size cursor, so it is
 * also the regression guard for the O(N^2) event payload it replaced.
 */

let userId: string;
let executionId: string;

const NODE_ID = "node_fanout";

/** The 156-row shape that failed in production, at production width. */
const items = Array.from({ length: 156 }, (_, i) => ({
  SNo: String(i),
  "Customer Name": `CUSTOMER ${i}`,
  "Vehicle No": "RJ34CA6253",
  Payment: "₹20,472.00",
  "Work Done": "INSURANCE & OIL SERVICE",
}));

const chainAt = (index: number): FanOutChain => ({
  nodeId: NODE_ID,
  outputKey: "MY_NODE_1",
  index,
  total: items.length,
  executionId,
  onItemFailure: "continue",
});

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;

  const workflow = await prisma.workflow.create({
    data: { name: "fan-out storage", userId },
    select: { id: true },
  });
  const execution = await prisma.execution.create({
    data: {
      workflowId: workflow.id,
      inngestEventId: `evt_${Date.now()}_${Math.random()}`,
    },
    select: { id: true },
  });
  executionId = execution.id;
});

afterAll(async () => {
  await cleanupDb();
});

/** Plans + stores the 156-item fan-out exactly as the dispatcher does. */
async function store() {
  const planned = planFanOutChain({
    items,
    context: {
      trigger_1: { name: "seed" },
      // The node's own summary — must NOT be stored. See `carriedContext`.
      MY_NODE_1: { matchCount: 156, rows: items },
    },
    outputKey: "MY_NODE_1",
    executionId,
    nodeId: NODE_ID,
    onItemFailure: "continue",
  });
  if (!planned) throw new Error("expected a plan");
  await storeFanOutSource({
    executionId,
    nodeId: NODE_ID,
    source: planned.source,
  });
  return planned;
}

describe("fan-out storage round-trip", () => {
  it("writes the shared context once and one row per item", async () => {
    await store();

    expect(await prisma.fanOutSource.count()).toBe(1);
    expect(await prisma.fanOutItem.count()).toBe(items.length);

    const source = await prisma.fanOutSource.findFirstOrThrow({
      select: { context: true },
    });
    // The ~75KB node summary is stored zero times, not once per item.
    expect(source.context).toEqual({ trigger_1: { name: "seed" } });
  });

  it("reads back exactly the item at the cursor, with the shared context", async () => {
    await store();

    for (const index of [0, 77, 155]) {
      const resolved = await readFanOutSource(chainAt(index));
      expect(resolved.item).toEqual(items[index]);
      expect(resolved.context).toEqual({ trigger_1: { name: "seed" } });
    }
  });

  it("walks the whole chain in item order", async () => {
    await store();

    const seen: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      seen.push((await readFanOutSource(chainAt(i))).item);
    }
    expect(seen).toEqual(items);
  });

  it("is a no-op when the dispatcher's step is retried", async () => {
    // Inngest re-runs a step's callback whole on retry. Storing twice must not
    // duplicate items or throw on the unique constraint — a plain create here
    // would fail identically forever and permanently kill the fan-out.
    await store();
    await expect(store()).resolves.toBeTruthy();

    expect(await prisma.fanOutSource.count()).toBe(1);
    expect(await prisma.fanOutItem.count()).toBe(items.length);
    expect((await readFanOutSource(chainAt(42))).item).toEqual(items[42]);
  });

  it("stores a null item without failing the whole write", async () => {
    // `FanOutItem.item` is a required Json column, and Prisma rejects a bare
    // `null` for one at runtime (it reads that as SQL NULL). A hole in an items
    // array is legitimate input that the pre-Postgres payload carried fine, so
    // it must not take the entire fan-out down with it.
    // `undefined` is covered alongside `null`: Prisma rejects it for a required
    // column too (as "omit this field"), and it is what a hole in a JS array
    // actually is — `[{a:1}, , {b:2}]` yields `undefined`, not `null`.
    await storeFanOutSource({
      executionId,
      nodeId: "node_nulls",
      source: { context: {}, items: [{ a: 1 }, null, undefined, { b: 2 }] },
    });

    const at = async (index: number) =>
      (
        await readFanOutSource({
          ...chainAt(index),
          nodeId: "node_nulls",
          total: 4,
        })
      ).item;

    expect(await at(0)).toEqual({ a: 1 });
    expect(await at(1)).toBeNull();
    // `undefined` cannot round-trip through JSON at all, so it reads back as
    // null — the same value the inline payload would have carried.
    expect(await at(2)).toBeNull();
    expect(await at(3)).toEqual({ b: 2 });
  });

  it("keeps two fan-out nodes in one execution separate", async () => {
    await store();
    await storeFanOutSource({
      executionId,
      nodeId: "node_other",
      source: { context: { trigger_1: { name: "other" } }, items: [{ z: 9 }] },
    });

    expect(await prisma.fanOutSource.count()).toBe(2);
    expect((await readFanOutSource(chainAt(3))).item).toEqual(items[3]);

    const other = await readFanOutSource({
      ...chainAt(0),
      nodeId: "node_other",
      total: 1,
    });
    expect(other.item).toEqual({ z: 9 });
  });

  it("fails non-retriably, naming the item, when the payload is gone", async () => {
    await store();
    await prisma.fanOutSource.deleteMany({});

    await expect(readFanOutSource(chainAt(5))).rejects.toThrow(
      /no longer exists[\s\S]*item 6 of 156/,
    );
  });

  it("fails non-retriably when the cursor is past the stored items", async () => {
    await store();

    await expect(readFanOutSource(chainAt(999))).rejects.toThrow(
      /Item 1000 of 156 is missing/,
    );
  });

  it("is dropped with its execution, so retention pruning needs no new wiring", async () => {
    await store();
    await prisma.execution.delete({ where: { id: executionId } });

    // Cascade reaches FanOutItem through FanOutSource.
    expect(await prisma.fanOutSource.count()).toBe(0);
    expect(await prisma.fanOutItem.count()).toBe(0);
  });
});
