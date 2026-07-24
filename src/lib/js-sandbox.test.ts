import { describe, expect, it } from "vitest";
import { runUserCode, SandboxError } from "./js-sandbox";

describe("runUserCode", () => {
  it("returns a computed value from the input context", async () => {
    const result = await runUserCode(
      "return input.AI_TEXT_1.output.toUpperCase();",
      { AI_TEXT_1: { output: "hello" } },
    );
    expect(result).toBe("HELLO");
  });

  it("supports full JS (filter/map over an array)", async () => {
    const result = await runUserCode(
      `return input.rows
         .filter((r) => r.amount > 100)
         .map((r) => ({ id: r.id, tax: r.amount * 0.18 }));`,
      {
        rows: [
          { id: "a", amount: 50 },
          { id: "b", amount: 200 },
          { id: "c", amount: 300 },
        ],
      },
    );
    expect(result).toEqual([
      { id: "b", tax: 36 },
      { id: "c", tax: 54 },
    ]);
  });

  it("marshals a returned object as plain JSON data", async () => {
    const result = await runUserCode(
      "return { a: 1, b: [2, 3], c: null };",
      {},
    );
    expect(result).toEqual({ a: 1, b: [2, 3], c: null });
  });

  it("treats a missing return as null", async () => {
    const result = await runUserCode("const x = 1 + 1;", {});
    expect(result).toBeNull();
  });

  it("treats a non-serialisable return (function) as null", async () => {
    const result = await runUserCode("return function () {};", {});
    expect(result).toBeNull();
  });

  it("surfaces a thrown error as a SandboxError with the message", async () => {
    await expect(
      runUserCode("throw new Error('boom');", {}),
    ).rejects.toThrowError(/boom/);
    await expect(
      runUserCode("throw new Error('boom');", {}),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("surfaces a syntax error as a SandboxError", async () => {
    await expect(runUserCode("return (((;", {})).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it("stops an infinite loop at the timeout", async () => {
    await expect(
      runUserCode("while (true) {}", {}, { timeoutMs: 100 }),
    ).rejects.toThrowError(/longer than 100ms/);
  });

  it("has no access to host globals (no require/process/fetch)", async () => {
    for (const global of ["require", "process", "fetch", "globalThis.Buffer"]) {
      const result = await runUserCode(`return typeof ${global};`, {});
      expect(result).toBe("undefined");
    }
  });

  it("preserves U+2028 inside string input without breaking the program", async () => {
    const tricky = `line${String.fromCharCode(0x2028)}sep`;
    const result = await runUserCode("return input.text;", { text: tricky });
    expect(result).toBe(tricky);
  });

  it("rejects input that cannot be serialised", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(runUserCode("return 1;", circular)).rejects.toBeInstanceOf(
      SandboxError,
    );
  });
});
