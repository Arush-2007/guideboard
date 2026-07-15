import { describe, expect, it } from "vitest";
import { DEFAULT_CLAMP_BYTES } from "@/lib/clamp-json";
import { FAN_OUT_MARKER, isFanOutItem, planFanOutDispatches } from "./fan-out";

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

describe("planFanOutDispatches", () => {
  const base = {
    context: {
      trigger_1: { name: "seed" },
      MY_NODE_1: { fannedOut: 2, total: 2 },
    },
    outputKey: "MY_NODE_1",
    executionId: "exec_abc",
    nodeId: "node_x",
  };

  it("returns [] for empty items", () => {
    expect(planFanOutDispatches({ ...base, items: [] })).toEqual([]);
  });

  it("formats the idempotency key with executionId, nodeId, and 0-based index", () => {
    const plans = planFanOutDispatches({
      ...base,
      items: [{ a: 1 }, { b: 2 }],
    });
    expect(plans.map((p) => p.idempotencyKey)).toEqual([
      "fanout:exec_abc:node_x:0",
      "fanout:exec_abc:node_x:1",
    ]);
  });

  it("seeds each child with the context, overwriting the node's own summary output under outputKey", () => {
    const plans = planFanOutDispatches({
      ...base,
      items: [{ email: "a@x.com" }, { email: "b@x.com" }],
    });

    // Parent context preserved except the fan-out node's own output key, which
    // is overwritten by the per-item seed.
    expect(plans[0].seeded.trigger_1).toEqual({ name: "seed" });
    expect(plans[0].seeded.MY_NODE_1).toEqual({
      item: { email: "a@x.com" },
      index: 1,
      total: 2,
      __fanOut: true,
    });
    expect(plans[1].seeded.MY_NODE_1).toEqual({
      item: { email: "b@x.com" },
      index: 2,
      total: 2,
      __fanOut: true,
    });
    // 1-based, user-facing index on the plan too.
    expect(plans.map((p) => p.index)).toEqual([1, 2]);
  });

  it("formats the blob key under replay-contexts/<executionId>/", () => {
    const plans = planFanOutDispatches({
      ...base,
      items: [{ a: 1 }, { b: 2 }],
    });
    expect(plans[0].blobKey).toBe(
      "replay-contexts/exec_abc/fan-out/node_x/0.json",
    );
    expect(plans[1].blobKey).toBe(
      "replay-contexts/exec_abc/fan-out/node_x/1.json",
    );
  });

  it("keeps oversized false for small seeds under the default limit", () => {
    const plans = planFanOutDispatches({
      ...base,
      items: [{ a: 1 }],
    });
    expect(plans[0].oversized).toBe(false);
  });

  it("flips oversized true when the seed exceeds a tiny inlineLimitBytes", () => {
    const small = planFanOutDispatches({
      ...base,
      items: [{ a: 1 }],
      inlineLimitBytes: DEFAULT_CLAMP_BYTES,
    });
    expect(small[0].oversized).toBe(false);

    const tiny = planFanOutDispatches({
      ...base,
      items: [{ a: 1 }],
      inlineLimitBytes: 1,
    });
    expect(tiny[0].oversized).toBe(true);
  });

  it("treats an unserializable seed (BigInt in context) as oversized without throwing", () => {
    const plans = planFanOutDispatches({
      context: { bad: BigInt(1) },
      outputKey: "MY_NODE_1",
      executionId: "exec_abc",
      nodeId: "node_x",
      items: [{ a: 1 }],
    });
    expect(plans[0].oversized).toBe(true);
  });
});
