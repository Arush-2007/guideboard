import { NonRetriableError } from "inngest";
import { describe, expect, it } from "vitest";
import { isFanOut } from "@/features/executions/types";
import { applyMultiMatchPolicy, assertFanOutCap } from "./multi-match-policy";

const outputKey = "GOOGLE_SHEETS_ACTION_1";
const output = { matchCount: 2, rows: [{ n: "a" }, { n: "b" }] };
const context = { upstream: { x: 1 } };

type ApplyArgs = Parameters<typeof applyMultiMatchPolicy>[0];

/**
 * `config` is spread rather than replaced, so a case that overrides one setting
 * (e.g. just `maxFanOutItems`) keeps the others at their defaults.
 */
const apply = (
  overrides: Partial<Omit<ApplyArgs, "config">> & {
    config?: Partial<ApplyArgs["config"]>;
  } = {},
) => {
  const { config, ...rest } = overrides;
  return applyMultiMatchPolicy({
    items: output.rows,
    context,
    outputKey,
    output,
    itemNoun: "row",
    ...rest,
    config: { ...config },
  });
};

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

describe("applyMultiMatchPolicy — last", () => {
  it("passes the output through exactly like 'first' (the node already chose the row)", () => {
    const result = apply({ mode: "last" });
    expect(isFanOut(result)).toBe(false);
    expect(result).toEqual({ ...context, [outputKey]: output });
  });

  it("never fails on a multi-match, however many matched", () => {
    expect(() => apply({ mode: "last", totalCount: 150 })).not.toThrow();
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

describe("applyMultiMatchPolicy — mode resolution", () => {
  it("takes the mode from config when no override is given", () => {
    // The primary route: the node's saved `onMultipleMatches`.
    const result = apply({ config: { onMultipleMatches: "each" } });
    expect(isFanOut(result)).toBe(true);
  });

  it("lets an explicit mode override config, for nodes whose mode is implied", () => {
    // The Sheets "insert under each match" append is always "each" regardless
    // of what `onMultipleMatches` happens to hold from another action.
    const result = apply({
      mode: "each",
      config: { onMultipleMatches: "first" },
    });
    expect(isFanOut(result)).toBe(true);
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

  it("carries the item-failure policy onto the outcome for the engine", () => {
    const result = apply({ mode: "each", config: { onItemFailure: "stop" } });
    if (!isFanOut(result)) throw new Error("unreachable");
    expect(result.onItemFailure).toBe("stop");
  });

  it("leaves the item-failure policy undefined when config sets none", () => {
    // The default is applied once, by the engine's dispatcher — the policy
    // module does not bake one in, so there is a single owner of it.
    const result = apply({ mode: "each" });
    if (!isFanOut(result)) throw new Error("unreachable");
    expect(result.onItemFailure).toBeUndefined();
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

  it("enforces the cap (default 100, override via config.maxFanOutItems)", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ i }));
    expect(() => apply({ mode: "each", items: many })).toThrow(
      NonRetriableError,
    );
    expect(() =>
      apply({ mode: "each", items: many, config: { maxFanOutItems: 101 } }),
    ).not.toThrow();
    expect(() =>
      apply({ mode: "each", config: { maxFanOutItems: 1 } }),
    ).toThrow(/Max rows/);
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
