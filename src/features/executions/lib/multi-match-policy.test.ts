import { NonRetriableError } from "inngest";
import { describe, expect, it } from "vitest";
import { isFanOut } from "@/features/executions/types";
import { applyMultiMatchPolicy, assertFanOutCap } from "./multi-match-policy";

const outputKey = "GOOGLE_SHEETS_ACTION_1";
const output = { matchCount: 2, rows: [{ n: "a" }, { n: "b" }] };
const context = { upstream: { x: 1 } };

const apply = (
  overrides: Partial<Parameters<typeof applyMultiMatchPolicy>[0]> = {},
) =>
  applyMultiMatchPolicy({
    mode: undefined,
    maxItems: undefined,
    items: output.rows,
    context,
    outputKey,
    output,
    itemNoun: "row",
    ...overrides,
  });

describe("applyMultiMatchPolicy — first (default)", () => {
  it("returns the normal output under the node's key, keeping the context", () => {
    const result = apply();
    expect(isFanOut(result)).toBe(false);
    expect(result).toEqual({ ...context, [outputKey]: output });
  });

  it("continues downstream even with zero items (matchCount workflows)", () => {
    const empty = { matchCount: 0, rows: [] };
    const result = apply({ items: [], output: empty });
    expect(isFanOut(result)).toBe(false);
    expect(result).toEqual({ ...context, [outputKey]: empty });
  });
});

describe("applyMultiMatchPolicy — error", () => {
  it("throws NonRetriableError when more than one item matched", () => {
    expect(() => apply({ mode: "error" })).toThrow(NonRetriableError);
    expect(() => apply({ mode: "error" })).toThrow(/2 matching rows/);
  });

  it("passes with zero or one item, behaving like 'first'", () => {
    const one = { matchCount: 1, rows: [{ n: "a" }] };
    const result = apply({ mode: "error", items: one.rows, output: one });
    expect(result).toEqual({ ...context, [outputKey]: one });
    expect(() =>
      apply({ mode: "error", items: [], output: { matchCount: 0 } }),
    ).not.toThrow();
  });

  it("reports the true totalCount when items is a truncated view", () => {
    // e.g. Sheets stores ≤100 rows but 150 matched: the message must say 150,
    // and a single stored item with totalCount > 1 must still fail.
    expect(() => apply({ mode: "error", totalCount: 150 })).toThrow(
      /150 matching rows/,
    );
    expect(() =>
      apply({ mode: "error", items: [{ n: "a" }], totalCount: 2 }),
    ).toThrow(NonRetriableError);
  });
});

describe("applyMultiMatchPolicy — each", () => {
  it("returns a fan-out outcome: one item per match, summary under the key", () => {
    const result = apply({ mode: "each" });
    expect(isFanOut(result)).toBe(true);
    if (!isFanOut(result)) throw new Error("unreachable");
    expect(result.items).toEqual(output.rows);
    expect(result.context).toEqual({
      ...context,
      [outputKey]: { ...output, fannedOut: 2 },
    });
  });

  it("fans out zero children on an empty list (downstream skipped)", () => {
    const result = apply({
      mode: "each",
      items: [],
      output: { matchCount: 0, rows: [] },
    });
    expect(isFanOut(result)).toBe(true);
    if (!isFanOut(result)) throw new Error("unreachable");
    expect(result.items).toEqual([]);
    expect((result.context[outputKey] as { fannedOut: number }).fannedOut).toBe(
      0,
    );
  });

  it("enforces the cap (default 100, override via maxItems)", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ i }));
    expect(() => apply({ mode: "each", items: many })).toThrow(
      NonRetriableError,
    );
    expect(() =>
      apply({ mode: "each", items: many, maxItems: 101 }),
    ).not.toThrow();
    expect(() => apply({ mode: "each", maxItems: 1 })).toThrow(/Max rows/);
  });

  it("rejects nested fan-out (a foreign per-item seed in the context)", () => {
    const nested = {
      ...context,
      OTHER_NODE_1: { item: {}, index: 1, total: 2, __fanOut: true },
    };
    expect(() => apply({ mode: "each", context: nested })).toThrow(
      /Nested fan-out/,
    );
    // The node's OWN key holding a seed is the child short-circuit's business,
    // not the nested guard's.
    const own = {
      ...context,
      [outputKey]: { item: {}, index: 1, total: 2, __fanOut: true },
    };
    expect(() => apply({ mode: "each", context: own })).not.toThrow();
  });
});

describe("assertFanOutCap", () => {
  it("throws over the cap with the item noun in the message, passes at it", () => {
    expect(() => assertFanOutCap(101, undefined, "row")).toThrow(/101/);
    expect(() => assertFanOutCap(100, undefined, "row")).not.toThrow();
    expect(() => assertFanOutCap(3, 2, "row")).toThrow(NonRetriableError);
  });
});
