import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Make `.status(payload)` return the payload so `publish` receives it verbatim,
// decoupling the test from the realtime message envelope.
vi.mock("@/inngest/channels/node-status", () => ({
  nodeStatusChannel: () => ({ status: (payload: unknown) => payload }),
}));

import type { NodeExecutorParams } from "@/features/executions/types";
import { codeExecutor } from "./executor";

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

const OUTPUT_KEY = "CODE_1";

const run = (code: string, context: Record<string, unknown> = {}) =>
  codeExecutor({
    data: { code },
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
  (context as Record<string, { result: unknown }>)[OUTPUT_KEY];

beforeEach(() => {
  publishedStatuses = [];
});

describe("codeExecutor", () => {
  it("runs the code against the context and writes { result }", async () => {
    const context = await run("return input.a + input.b;", { a: 2, b: 3 });
    expect(outputOf(context).result).toBe(5);
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("preserves upstream context alongside its own output", async () => {
    const context = await run("return 1;", { EARLIER: { keep: "me" } });
    expect((context as Record<string, unknown>).EARLIER).toEqual({
      keep: "me",
    });
    expect(outputOf(context).result).toBe(1);
  });

  it("returns a rich object downstream nodes can drill into", async () => {
    const context = await run(
      "return { total: input.items.reduce((s, n) => s + n, 0) };",
      { items: [10, 20, 30] },
    );
    expect(outputOf(context).result).toEqual({ total: 60 });
  });

  it("throws a NonRetriableError (with a friendly message) on a thrown error", async () => {
    await expect(run("throw new Error('nope');", {})).rejects.toBeInstanceOf(
      NonRetriableError,
    );
    await expect(run("throw new Error('nope');", {})).rejects.toThrowError(
      /Code: .*nope/,
    );
    expect(publishedStatuses).toContain("error");
  });

  it("throws a NonRetriableError on a syntax error", async () => {
    await expect(run("return (((;", {})).rejects.toBeInstanceOf(
      NonRetriableError,
    );
  });

  it("cannot reach host globals", async () => {
    const context = await run(
      "return [typeof process, typeof require, typeof fetch];",
      {},
    );
    expect(outputOf(context).result).toEqual([
      "undefined",
      "undefined",
      "undefined",
    ]);
  });
});
