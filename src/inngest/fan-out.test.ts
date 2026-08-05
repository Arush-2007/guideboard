import { describe, expect, it } from "vitest";
import {
  buildFanOutSeed,
  FAN_OUT_MARKER,
  FAN_OUT_SOURCE_MAX_BYTES,
  type FanOutChain,
  fanOutItemIdempotencyKey,
  isFanOutItem,
  planChainAdvance,
  planFanOutChain,
  remainingAfter,
} from "./fan-out";

describe("isFanOutItem", () => {
  it("is true for an object carrying __fanOut === true", () => {
    expect(isFanOutItem({ [FAN_OUT_MARKER]: true })).toBe(true);
    expect(isFanOutItem({ item: 1, index: 1, total: 2, __fanOut: true })).toBe(
      true,
    );
  });

  it("is false for objects without the marker (or with a non-true marker)", () => {
    expect(isFanOutItem({})).toBe(false);
    expect(isFanOutItem({ __fanOut: false })).toBe(false);
    expect(isFanOutItem({ __fanOut: "true" })).toBe(false);
  });

  it("is false for null and primitives", () => {
    expect(isFanOutItem(null)).toBe(false);
    expect(isFanOutItem(undefined)).toBe(false);
    expect(isFanOutItem(42)).toBe(false);
    expect(isFanOutItem("string")).toBe(false);
    expect(isFanOutItem(true)).toBe(false);
  });
});

describe("fanOutItemIdempotencyKey", () => {
  it("formats with executionId, nodeId, and a 0-based index", () => {
    expect(fanOutItemIdempotencyKey("exec_abc", "node_x", 0)).toBe(
      "fanout:exec_abc:node_x:0",
    );
    expect(fanOutItemIdempotencyKey("exec_abc", "node_x", 7)).toBe(
      "fanout:exec_abc:node_x:7",
    );
  });
});

describe("buildFanOutSeed", () => {
  const context = {
    trigger_1: { name: "seed" },
    MY_NODE_1: { fannedOut: 2, total: 2 },
  };

  it("overwrites the node's own summary output with the per-item seed", () => {
    const seeded = buildFanOutSeed({
      context,
      outputKey: "MY_NODE_1",
      item: { email: "a@x.com" },
      index: 0,
      total: 2,
    });

    // Parent context preserved except the fan-out node's own key.
    expect(seeded.trigger_1).toEqual({ name: "seed" });
    expect(seeded.MY_NODE_1).toEqual({
      item: { email: "a@x.com" },
      index: 1,
      total: 2,
      __fanOut: true,
    });
  });

  it("surfaces the 0-based cursor as a 1-based, user-facing index", () => {
    const seeded = buildFanOutSeed({
      context,
      outputKey: "MY_NODE_1",
      item: { email: "b@x.com" },
      index: 1,
      total: 2,
    });
    expect(seeded.MY_NODE_1).toMatchObject({ index: 2, total: 2 });
  });
});

describe("planFanOutChain", () => {
  const base = {
    context: {
      trigger_1: { name: "seed" },
      MY_NODE_1: { fannedOut: 2, total: 2 },
    },
    outputKey: "MY_NODE_1",
    executionId: "exec_abc",
    nodeId: "node_x",
    onItemFailure: "continue" as const,
  };

  it("returns null for empty items — there is no chain to start", () => {
    expect(planFanOutChain({ ...base, items: [] })).toBeNull();
  });

  it("starts the chain at cursor 0 carrying nothing but the cursor", () => {
    const planned = planFanOutChain({
      ...base,
      items: [{ a: 1 }, { b: 2 }, { c: 3 }],
    });

    // Exhaustive on purpose: any payload field re-added to the descriptor puts
    // the data back on the event and this fails.
    expect(planned?.chain).toEqual({
      nodeId: "node_x",
      outputKey: "MY_NODE_1",
      index: 0,
      total: 3,
      executionId: "exec_abc",
      onItemFailure: "continue",
    });
  });

  it("carries the failure policy the parent resolved", () => {
    const planned = planFanOutChain({
      ...base,
      onItemFailure: "stop",
      items: [{ a: 1 }],
    });
    expect(planned?.chain.onItemFailure).toBe("stop");
  });

  it("hands back the shared context and every item as the payload to store", () => {
    const planned = planFanOutChain({ ...base, items: [{ a: 1 }, { b: 2 }] });

    expect(planned?.source).toEqual({
      // `MY_NODE_1` (the node's own summary) is deliberately absent — see below.
      context: { trigger_1: { name: "seed" } },
      items: [{ a: 1 }, { b: 2 }],
    });
  });

  it("strips the node's own summary, and the seed restores it", () => {
    // Regression: see `carriedContext`. `base.context` already holds the node's
    // own MY_NODE_1 summary, which is the thing that must not be stored.
    const planned = planFanOutChain({ ...base, items: [{ a: 1 }, { b: 2 }] });
    expect(planned?.source.context).toEqual({ trigger_1: { name: "seed" } });

    // The child loses nothing: the seed supplies MY_NODE_1, and every other key
    // survives untouched.
    const seed = buildFanOutSeed({
      context: planned?.source.context ?? {},
      item: planned?.source.items[0],
      outputKey: "MY_NODE_1",
      index: 0,
      total: 2,
    });
    expect(seed.MY_NODE_1).toEqual({
      item: { a: 1 },
      index: 1,
      total: 2,
      __fanOut: true,
    });
    expect(seed.trigger_1).toEqual({ name: "seed" });
  });

  it("produces a link whose size does not grow with the item count", () => {
    // THE regression. Links used to carry the items still to do, so an N-item
    // fan-out moved O(N^2) bytes and a few hundred sheet rows blew the Inngest
    // event budget — which is what made R2 load-bearing. A link is now a cursor,
    // so 5 items and 5000 items put identical bytes on the wire.
    const link = (count: number) =>
      Buffer.byteLength(
        JSON.stringify(
          planFanOutChain({
            ...base,
            items: Array.from({ length: count }, (_, i) => ({ row: i })),
          })?.chain,
        ),
      );

    // `total` is the only field that varies, and only by its digit count.
    expect(link(5000)).toBeLessThan(link(5) + 8);
    expect(link(5000)).toBeLessThan(300);
  });

  it("measures the payload it hands back, not the link", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ row: i }));
    const planned = planFanOutChain({ ...base, items });

    expect(planned?.sourceBytes).toBe(
      Buffer.byteLength(JSON.stringify(planned?.source), "utf8"),
    );
    // Well inside the guard — the guard exists for absurd payloads, not for
    // ordinary fan-outs, which must never be routed anywhere special again.
    expect(planned?.sourceBytes).toBeLessThan(FAN_OUT_SOURCE_MAX_BYTES);
  });

  it("reports an unserializable payload as over budget rather than throwing", () => {
    // A BigInt cannot be stored as JSON either, so there is nothing to route it
    // to — the caller fails it with the one message it already has.
    const planned = planFanOutChain({
      ...base,
      context: { bad: BigInt(1) },
      items: [{ a: 1 }],
    });
    expect(planned?.sourceBytes).toBe(Number.POSITIVE_INFINITY);
    expect(planned?.sourceBytes).toBeGreaterThan(FAN_OUT_SOURCE_MAX_BYTES);
  });

  it("stores a real 156-row Sheets fan-out well inside the guard", () => {
    // The exact shape that failed in production: 156 16-column rows, and a
    // fan-out node summary carrying 100 of those rows plus a columnValues entry
    // per column (~75KB). It used to be pushed onto blob storage that was not
    // configured, killing the run.
    const row = {
      SNo: "23",
      Date: "04-06-2026",
      TYPE: "PRIVATE",
      Model: "SCORPIO",
      Payment: "₹20,472.00",
      Discount: "₹100.00",
      Odometer: "31158",
      "Work Done": "INSURANCE & OIL SERVICE",
      "Vehicle No": "RJ34CA6253",
      "Bill Number": "32",
      "Due Balance": "₹0.00",
      "Total Amount": "₹20,572.00",
      "Customer Name": "AVLESH MEENA",
      "Contact Number": "9887163151",
      "Job Card Number": "1373",
      "Customer Address": "KARAULI",
    };
    const items = Array.from({ length: 156 }, (_, i) => ({
      ...row,
      SNo: String(i),
    }));
    const summary = {
      matchCount: 156,
      rows: items.slice(0, 100),
      columnValues: Object.fromEntries(
        Object.keys(row).map((k) => [
          k,
          JSON.stringify(items.map((r) => r[k as keyof typeof row])),
        ]),
      ),
    };

    const planned = planFanOutChain({
      ...base,
      context: { trigger_1: { name: "seed" }, MY_NODE_1: summary },
      items,
    });

    expect(planned?.sourceBytes).toBeLessThan(FAN_OUT_SOURCE_MAX_BYTES);
    // The link stays a cursor even here, where the payload is ~100KB.
    expect(Buffer.byteLength(JSON.stringify(planned?.chain))).toBeLessThan(200);
    // The 75KB summary is stored zero times, not 156.
    expect(planned?.source.context).toEqual({ trigger_1: { name: "seed" } });
  });
});

describe("planChainAdvance", () => {
  const chain: FanOutChain = {
    nodeId: "node_x",
    outputKey: "MY_NODE_1",
    index: 0,
    total: 3,
    executionId: "exec_abc",
    onItemFailure: "continue",
  };

  it("advances the cursor and mints the next item's idempotency key", () => {
    const next = planChainAdvance(chain);
    expect(next?.chain.index).toBe(1);
    expect(next?.idempotencyKey).toBe("fanout:exec_abc:node_x:1");
  });

  it("changes nothing but the cursor", () => {
    const next = planChainAdvance(chain);
    expect(next?.chain).toEqual({ ...chain, index: 1 });
  });

  it("returns null on the last item — the chain is finished", () => {
    expect(planChainAdvance({ ...chain, index: 2 })).toBeNull();
  });

  it("carries the failure policy forward", () => {
    const next = planChainAdvance({ ...chain, onItemFailure: "stop" });
    expect(next?.chain.onItemFailure).toBe("stop");
  });

  it("walks every index exactly once, in item order", () => {
    const seen: number[] = [];
    let link: FanOutChain | undefined = planFanOutChain({
      context: {},
      outputKey: "MY_NODE_1",
      executionId: "exec_abc",
      nodeId: "node_x",
      onItemFailure: "continue",
      items: [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }],
    })?.chain;

    while (link) {
      seen.push(link.index);
      link = planChainAdvance(link)?.chain;
    }

    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe("remainingAfter", () => {
  const chain: FanOutChain = {
    nodeId: "node_x",
    outputKey: "MY_NODE_1",
    index: 0,
    total: 5,
    executionId: "exec_abc",
    onItemFailure: "stop",
  };

  it("counts the items after this one", () => {
    expect(remainingAfter(chain)).toBe(4);
    expect(remainingAfter({ ...chain, index: 3 })).toBe(1);
  });

  it("is 0 on the last item, and never negative", () => {
    expect(remainingAfter({ ...chain, index: 4 })).toBe(0);
    expect(remainingAfter({ ...chain, index: 9 })).toBe(0);
  });
});
