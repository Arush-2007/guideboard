import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Make `.status(payload)` return the payload so `publish` receives it verbatim,
// decoupling the test from the realtime message envelope.
vi.mock("@/inngest/channels/node-status", () => ({
  nodeStatusChannel: () => ({ status: (payload: unknown) => payload }),
}));

import type { NodeExecutorParams } from "@/features/executions/types";
import { calculatorExecutor, resolveExpressionVariables } from "./executor";

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

const OUTPUT_KEY = "CALCULATOR_1";

const run = (expression: string, context: Record<string, unknown> = {}) =>
  calculatorExecutor({
    data: { expression },
    nodeId: "node-1",
    outputKey: OUTPUT_KEY,
    executionId: "exec-1",
    userId: "user-1",
    context,
    step: {
      run: async (_name: string, fn: () => unknown) => fn(),
    } as unknown as NodeExecutorParams["step"],
    publish,
  });

/** The node's own output slice from a returned context. */
const outputOf = (context: unknown) =>
  (context as Record<string, { result: number; expression: string }>)[
    OUTPUT_KEY
  ];

beforeEach(() => {
  publishedStatuses = [];
});

describe("resolveExpressionVariables", () => {
  it("substitutes a referenced number", () => {
    expect(
      resolveExpressionVariables("@<sheet.price>@ * 2", {
        sheet: { price: 21 },
      }),
    ).toBe("21 * 2");
  });

  it("substitutes several references, including repeats", () => {
    expect(
      resolveExpressionVariables("@<a.n>@ + @<b.n>@ + @<a.n>@", {
        a: { n: 1 },
        b: { n: 2 },
      }),
    ).toBe("1 + 2 + 1");
  });

  it("leaves an expression with no references untouched", () => {
    expect(resolveExpressionVariables("2 + 2", {})).toBe("2 + 2");
  });

  it("brackets a negative value so it can't merge with an operator", () => {
    expect(resolveExpressionVariables("1 - @<x.n>@", { x: { n: -3 } })).toBe(
      "1 - (-3)",
    );
  });

  describe("structural safety", () => {
    // The reason each token is rendered individually instead of rendering the
    // whole string in one pass. A single-pass render would produce "2 * 1+1"
    // here, which parses as (2*1)+1 = 3 — an upstream VALUE silently rewriting
    // the STRUCTURE of the user's calculation.
    it("rejects a value that would inject operators", () => {
      expect(() =>
        resolveExpressionVariables("2 * @<x.v>@", { x: { v: "1+1" } }),
      ).toThrow(/is not a number/);
    });

    it("rejects a value that would inject brackets", () => {
      expect(() =>
        resolveExpressionVariables("@<x.v>@ + 1", { x: { v: "2) * (9" } }),
      ).toThrow(/is not a number/);
    });

    it("rejects a value that would inject a function call", () => {
      expect(() =>
        resolveExpressionVariables("@<x.v>@", { x: { v: "round(1.5)" } }),
      ).toThrow(/is not a number/);
    });
  });

  describe("coercion of real-world values", () => {
    it.each([
      ["1,234.50", 1234.5],
      ["₹1,234", 1234],
      ["$ 99.99", 99.99],
      [" 42 ", 42],
      ["-17", -17],
      ["0", 0],
      ["3.0", 3],
    ])("reads %j as %d", (raw, expected) => {
      const resolved = resolveExpressionVariables("@<x.v>@", { x: { v: raw } });
      expect(Number(resolved.replace(/[()]/g, ""))).toBe(expected);
    });

    it("accepts a genuine number, not just numeric strings", () => {
      expect(resolveExpressionVariables("@<x.v>@", { x: { v: 7 } })).toBe("7");
    });

    // Regression: substituting with String() wrote "1e-7" into the expression,
    // and the tokenizer then rejected the `e` as an unknown name — the node
    // failed on a value that was a perfectly good number.
    it("substitutes very small numbers in plain decimal", () => {
      expect(resolveExpressionVariables("@<x.v>@", { x: { v: 1e-7 } })).toBe(
        "0.0000001",
      );
    });

    it("substitutes very large numbers in plain decimal", () => {
      expect(resolveExpressionVariables("@<x.v>@", { x: { v: 1e21 } })).toBe(
        "1000000000000000000000",
      );
    });

    it("brackets a very small negative number", () => {
      expect(resolveExpressionVariables("@<x.v>@", { x: { v: -1e-8 } })).toBe(
        "(-0.00000001)",
      );
    });

    it.each([["N/A"], ["12.5%"], ["abc"], ["--"], ["Infinity"]])(
      "rejects %j",
      (raw) => {
        expect(() =>
          resolveExpressionVariables("@<x.v>@", { x: { v: raw } }),
        ).toThrow(/is not a number/);
      },
    );

    // Regression: whitespace was stripped everywhere, so a cell holding two
    // values — a mis-split column, or a stray space — silently fused into one
    // number and the node reported success on a figure nobody entered.
    it.each([["12 34"], ["1, 2"], ["1 000 000"], ["3 . 5"]])(
      "rejects %j rather than fusing it into one number",
      (raw) => {
        expect(() =>
          resolveExpressionVariables("@<x.v>@", { x: { v: raw } }),
        ).toThrow(/is not a number/);
      },
    );

    it("still accepts a currency symbol separated by a space", () => {
      // The space is only ever OUTSIDE the digits here, so this stays valid.
      expect(
        resolveExpressionVariables("@<x.v>@", { x: { v: "$ 99.99" } }),
      ).toBe("99.99");
      expect(
        resolveExpressionVariables("@<x.v>@", { x: { v: " ₹1,234 " } }),
      ).toBe("1234");
    });
  });

  describe("failure messages", () => {
    it("names the path and the offending value", () => {
      expect(() =>
        resolveExpressionVariables("@<sheet.price>@", {
          sheet: { price: "N/A" },
        }),
      ).toThrow(/sheet\.price is not a number \(got "N\/A"\)/);
    });

    it("distinguishes a missing value from a non-numeric one", () => {
      expect(() => resolveExpressionVariables("@<sheet.price>@", {})).toThrow(
        /sheet\.price has no value/,
      );
    });

    it("fails non-retriably — a retry can't make it a number", () => {
      expect(() =>
        resolveExpressionVariables("@<x.v>@", { x: { v: "N/A" } }),
      ).toThrow(NonRetriableError);
    });
  });
});

describe("calculatorExecutor", () => {
  it("computes a literal expression and writes it under the output key", async () => {
    const context = await run("2 + 3 * 4");
    expect(outputOf(context)).toEqual({ result: 14, expression: "2 + 3 * 4" });
  });

  it("threads the incoming context through untouched", async () => {
    const context = await run("1 + 1", { existing: "value" });
    expect(context).toMatchObject({ existing: "value" });
  });

  it("computes from upstream values", async () => {
    const context = await run("@<sheet.price>@ * 1.18", {
      sheet: { price: 1200 },
    });
    expect(outputOf(context).result).toBe(1416);
  });

  it("records the RESOLVED expression, so a run log shows what was computed", async () => {
    const context = await run("@<sheet.price>@ * 2", { sheet: { price: 50 } });
    expect(outputOf(context).expression).toBe("50 * 2");
  });

  it("publishes loading then success", async () => {
    await run("1 + 1");
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("publishes loading then error on failure", async () => {
    await expect(run("1 / 0")).rejects.toThrow();
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });

  it("fails non-retriably on a malformed expression", async () => {
    await expect(run("1 +")).rejects.toThrow(NonRetriableError);
  });

  it("prefixes evaluator errors so the node is identifiable in a run log", async () => {
    await expect(run("1 / 0")).rejects.toThrow(
      /Calculator: Can't divide by zero/,
    );
  });

  it("rejects an empty expression via the config schema", async () => {
    await expect(run("")).rejects.toThrow(NonRetriableError);
  });

  it("points Handlebars users at the {x} key", async () => {
    await expect(run("{{sheet.price}} * 2")).rejects.toThrow(/\{x\} key/);
  });

  it("computes end-to-end with an exponentially-stringified upstream value", async () => {
    const context = await run("@<x.v>@ * 10000000", { x: { v: 1e-7 } });
    expect(outputOf(context).result).toBe(1);
  });

  it("surfaces a bad upstream value as a node failure, not a silent zero", async () => {
    await expect(
      run("@<sheet.price>@ * 2", { sheet: { price: "N/A" } }),
    ).rejects.toThrow(/sheet\.price is not a number/);
  });
});
