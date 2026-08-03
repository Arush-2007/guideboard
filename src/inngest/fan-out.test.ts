import { describe, expect, it } from "vitest";
import {
  buildFanOutSeed,
  FAN_OUT_CHAIN_INLINE_LIMIT_BYTES,
  FAN_OUT_MARKER,
  type FanOutChain,
  fanOutChainBlobKey,
  fanOutItemIdempotencyKey,
  isFanOutItem,
  planChainAdvance,
  planFanOutChain,
  remainingAfter,
  resolveChainSeed,
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

describe("fanOutChainBlobKey", () => {
  it("sits under the replay-contexts/<executionId>/ prefix that pruning GCs", () => {
    expect(fanOutChainBlobKey("exec_abc", "node_x")).toBe(
      "replay-contexts/exec_abc/fan-out/node_x/chain.json",
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

  it("starts the chain at cursor 0 with every item still remaining", () => {
    const planned = planFanOutChain({
      ...base,
      items: [{ a: 1 }, { b: 2 }, { c: 3 }],
    });

    expect(planned?.chain).toEqual({
      nodeId: "node_x",
      outputKey: "MY_NODE_1",
      index: 0,
      total: 3,
      executionId: "exec_abc",
      onItemFailure: "continue",
      context: base.context,
      remaining: [{ a: 1 }, { b: 2 }, { c: 3 }],
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

  it("keeps oversized false for a small chain under the default limit", () => {
    const planned = planFanOutChain({ ...base, items: [{ a: 1 }] });
    expect(planned?.oversized).toBe(false);
    expect(planned?.chain.chainBlobKey).toBeUndefined();
  });

  it("swaps the inline payload for a blob key when over the limit", () => {
    const planned = planFanOutChain({
      ...base,
      items: [{ a: 1 }],
      inlineLimitBytes: 1,
    });

    expect(planned?.oversized).toBe(true);
    expect(planned?.chain.chainBlobKey).toBe(
      "replay-contexts/exec_abc/fan-out/node_x/chain.json",
    );
    // The oversized descriptor carries no payload of its own — that's the point.
    expect(planned?.chain.context).toBeUndefined();
    expect(planned?.chain.remaining).toBeUndefined();
    // …and the payload it replaced is handed back for the dispatcher to store.
    expect(planned?.blob).toEqual({ context: base.context, items: [{ a: 1 }] });
  });

  it("goes to a blob when the AGGREGATE exceeds budget, even if each link fits", () => {
    // 400 items whose first link is ~10 KB: comfortably under the 128 KB
    // per-event limit, but re-shipped 400 times it moves ~4 MB. The per-event
    // check alone would wave this through.
    const items = Array.from({ length: 400 }, (_, i) => ({ row: i }));
    const planned = planFanOutChain({
      ...base,
      items,
      totalBudgetBytes: 1_000_000,
    });

    expect(planned?.oversized).toBe(true);
    expect(planned?.chain.chainBlobKey).toBeDefined();

    // Same chain with a generous aggregate budget stays inline — proving it is
    // the aggregate, not the per-event size, that rejected it.
    expect(
      planFanOutChain({ ...base, items, totalBudgetBytes: 1_000_000_000 })
        ?.oversized,
    ).toBe(false);
  });

  it("treats an unserializable chain (BigInt in context) as oversized without throwing", () => {
    const planned = planFanOutChain({
      ...base,
      context: { bad: BigInt(1) },
      items: [{ a: 1 }],
    });
    expect(planned?.oversized).toBe(true);
  });

  it("measures the FIRST link, which is the largest the chain will produce", () => {
    // `remaining` only shrinks, so if item 0 fits inline every later hop does.
    const items = Array.from({ length: 50 }, (_, i) => ({ row: i }));
    const planned = planFanOutChain({ ...base, items });
    expect(planned?.oversized).toBe(false);

    const firstBytes = Buffer.byteLength(JSON.stringify(planned?.chain));
    const second = planChainAdvance(planned?.chain as FanOutChain);
    const secondBytes = Buffer.byteLength(JSON.stringify(second?.chain));
    expect(secondBytes).toBeLessThan(firstBytes);
    expect(firstBytes).toBeLessThan(FAN_OUT_CHAIN_INLINE_LIMIT_BYTES);
  });
});

describe("resolveChainSeed", () => {
  const context = { trigger_1: { name: "seed" } };

  it("takes the head of `remaining` on the inline shape", () => {
    const chain: FanOutChain = {
      nodeId: "node_x",
      outputKey: "MY_NODE_1",
      index: 1,
      total: 3,
      executionId: "exec_abc",
      onItemFailure: "continue",
      context,
      remaining: [{ b: 2 }, { c: 3 }],
    };
    expect(resolveChainSeed(chain)).toEqual({ context, item: { b: 2 } });
  });

  it("indexes into the hydrated blob on the blob shape", () => {
    const chain: FanOutChain = {
      nodeId: "node_x",
      outputKey: "MY_NODE_1",
      index: 2,
      total: 3,
      executionId: "exec_abc",
      onItemFailure: "continue",
      chainBlobKey: "replay-contexts/exec_abc/fan-out/node_x/chain.json",
    };
    const blob = { context, items: [{ a: 1 }, { b: 2 }, { c: 3 }] };
    expect(resolveChainSeed(chain, blob)).toEqual({
      context,
      item: { c: 3 },
    });
  });

  it("throws when the blob shape is resolved without its payload", () => {
    const chain: FanOutChain = {
      nodeId: "node_x",
      outputKey: "MY_NODE_1",
      index: 0,
      total: 1,
      executionId: "exec_abc",
      onItemFailure: "continue",
      chainBlobKey: "replay-contexts/exec_abc/fan-out/node_x/chain.json",
    };
    expect(() => resolveChainSeed(chain)).toThrow(/no payload was hydrated/);
  });
});

describe("planChainAdvance", () => {
  const inline: FanOutChain = {
    nodeId: "node_x",
    outputKey: "MY_NODE_1",
    index: 0,
    total: 3,
    executionId: "exec_abc",
    onItemFailure: "continue",
    context: { trigger_1: { name: "seed" } },
    remaining: [{ a: 1 }, { b: 2 }, { c: 3 }],
  };

  it("advances the cursor and drops the consumed item", () => {
    const next = planChainAdvance(inline);
    expect(next?.chain.index).toBe(1);
    expect(next?.chain.remaining).toEqual([{ b: 2 }, { c: 3 }]);
    expect(next?.idempotencyKey).toBe("fanout:exec_abc:node_x:1");
  });

  it("returns null at the last item, ending the chain", () => {
    const last: FanOutChain = { ...inline, index: 2, remaining: [{ c: 3 }] };
    expect(planChainAdvance(last)).toBeNull();
  });

  it("carries the failure policy forward unchanged", () => {
    const next = planChainAdvance({ ...inline, onItemFailure: "stop" });
    expect(next?.chain.onItemFailure).toBe("stop");
  });

  it("advances the blob shape by cursor alone, adding no `remaining`", () => {
    const blobChain: FanOutChain = {
      nodeId: "node_x",
      outputKey: "MY_NODE_1",
      index: 0,
      total: 3,
      executionId: "exec_abc",
      onItemFailure: "continue",
      chainBlobKey: "replay-contexts/exec_abc/fan-out/node_x/chain.json",
    };
    const next = planChainAdvance(blobChain);
    expect(next?.chain).toEqual({ ...blobChain, index: 1 });
    expect(next?.chain.remaining).toBeUndefined();
  });

  it("walks a whole chain in item order, one hop at a time", () => {
    const seen: unknown[] = [];
    let chain: FanOutChain | undefined = inline;
    while (chain) {
      seen.push(resolveChainSeed(chain).item);
      chain = planChainAdvance(chain)?.chain;
    }
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe("remainingAfter", () => {
  const chain: FanOutChain = {
    nodeId: "node_x",
    outputKey: "MY_NODE_1",
    index: 3,
    total: 10,
    executionId: "exec_abc",
    onItemFailure: "stop",
  };

  it("counts the items a stopped chain never started", () => {
    expect(remainingAfter(chain)).toBe(6);
  });

  it("is 0 on the last item", () => {
    expect(remainingAfter({ ...chain, index: 9 })).toBe(0);
  });
});
