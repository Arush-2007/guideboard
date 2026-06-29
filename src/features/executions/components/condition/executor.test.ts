import { describe, expect, it } from "vitest";
import { isRouted, type NodeOutcome } from "@/features/executions/types";
import { conditionExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as any;
const publish = (async () => {}) as any;

const run = async (
  data: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<NodeOutcome> => {
  const result = await conditionExecutor({
    data,
    nodeId: "c1",
    outputKey: "CONDITION_1",
    userId: "u1",
    context,
    step,
    publish,
  } as any);
  if (!isRouted(result)) throw new Error("expected a routed outcome");
  return result;
};

const aiYes = { ai_text_a1: { output: "Yes" } };

describe("conditionExecutor routing", () => {
  it("routes to `true` and preserves context when the condition passes", async () => {
    const outcome = await run(
      { field: "@<ai_text_a1.output>@", operator: "equals", value: "Yes" },
      aiYes,
    );
    expect(outcome.outputs).toContain("true");
    expect(outcome.outputs).not.toContain("false");
    expect(outcome.context).toMatchObject(aiYes);
    // Records its boolean decision under its output key (drives the exec view).
    expect(outcome.context).toMatchObject({ CONDITION_1: { result: true } });
  });

  it("emits legacy aliases on the pass path for pre-branching workflows", async () => {
    // Edges saved before branching carry fromOutput "main"/"source-1"; emitting
    // them as aliases of the pass path keeps those workflows working unmigrated.
    const outcome = await run(
      { field: "Yes", operator: "equals", value: "Yes" },
      aiYes,
    );
    expect(outcome.outputs).toEqual(
      expect.arrayContaining(["true", "main", "source-1"]),
    );
  });

  it("routes to `false` (only) when the condition fails", async () => {
    const outcome = await run(
      { field: "@<ai_text_a1.output>@", operator: "equals", value: "Nope" },
      aiYes,
    );
    expect(outcome.outputs).toEqual(["false"]);
    expect(outcome.context).toMatchObject({ CONDITION_1: { result: false } });
  });

  it("compares two upstream node outputs against each other", async () => {
    const matched = await run(
      {
        field: "@<ai_text_a1.output>@",
        operator: "equals",
        value: "@<ai_text_b1.output>@",
      },
      { ai_text_a1: { output: "match" }, ai_text_b1: { output: "match" } },
    );
    expect(matched.outputs).toContain("true");

    const mismatched = await run(
      {
        field: "@<ai_text_a1.output>@",
        operator: "equals",
        value: "@<ai_text_b1.output>@",
      },
      { ai_text_a1: { output: "x" }, ai_text_b1: { output: "y" } },
    );
    expect(mismatched.outputs).toEqual(["false"]);
  });

  it("treats a bare dot-path (no markers) as a literal, not a reference", async () => {
    const outcome = await run(
      { field: "ai_text_a1.output", operator: "equals", value: "Yes" },
      aiYes,
    );
    expect(outcome.outputs).toEqual(["false"]);
  });

  it("throws a config error when the field is missing", async () => {
    // The schema (parseNodeConfig) rejects a missing field before the executor's
    // own guard; either way it's a NonRetriableError mentioning the field.
    await expect(
      run({ operator: "equals", value: "Yes" }, aiYes),
    ).rejects.toThrow(/field/i);
  });
});
