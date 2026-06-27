import { describe, expect, it } from "vitest";
import { conditionExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as any;
const publish = (async () => {}) as any;

const run = (data: Record<string, unknown>, context: Record<string, unknown>) =>
  conditionExecutor({
    data,
    nodeId: "c1",
    userId: "u1",
    context,
    step,
    publish,
  } as any);

const aiYes = { ai_text_a1: { output: "Yes" } };

describe("conditionExecutor operand resolution", () => {
  it("compares an upstream reference (field) against a fixed literal (value)", async () => {
    // The natural shape: field = node reference, value = literal "Yes".
    await expect(
      run(
        {
          field: "@<ai_text_a1.output>@",
          operator: "equals",
          value: "Yes",
          stopOnFail: true,
        },
        aiYes,
      ),
    ).resolves.toMatchObject(aiYes);
  });

  it("compares two upstream node outputs against each other", async () => {
    // The case the user asked for: both sides reference previous nodes.
    await expect(
      run(
        {
          field: "@<ai_text_a1.output>@",
          operator: "equals",
          value: "@<ai_text_b1.output>@",
          stopOnFail: true,
        },
        { ai_text_a1: { output: "match" }, ai_text_b1: { output: "match" } },
      ),
    ).resolves.toBeDefined();

    await expect(
      run(
        {
          field: "@<ai_text_a1.output>@",
          operator: "equals",
          value: "@<ai_text_b1.output>@",
          stopOnFail: true,
        },
        { ai_text_a1: { output: "x" }, ai_text_b1: { output: "y" } },
      ),
    ).rejects.toThrow(/condition not met/i);
  });

  it("treats plain text on either side as a fixed literal", async () => {
    await expect(
      run(
        { field: "Yes", operator: "equals", value: "Yes", stopOnFail: true },
        aiYes,
      ),
    ).resolves.toBeDefined();
  });

  it("treats a bare dot-path (no markers) as a literal, not a reference", async () => {
    // Pure semantics: a reference MUST be wrapped in @<...>@. A bare path is
    // just text, so it does not equal the resolved AI output. (Existing rows
    // are converted to the @<...>@ form by the backfill migration.)
    await expect(
      run(
        {
          field: "ai_text_a1.output",
          operator: "equals",
          value: "Yes",
          stopOnFail: true,
        },
        aiYes,
      ),
    ).rejects.toThrow(/condition not met/i);
  });

  it("does not stop the workflow when stopOnFail is false", async () => {
    await expect(
      run(
        { field: "no", operator: "equals", value: "yes", stopOnFail: false },
        {},
      ),
    ).resolves.toBeDefined();
  });
});
