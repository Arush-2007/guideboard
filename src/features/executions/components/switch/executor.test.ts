import { describe, expect, it } from "vitest";
import { isRouted, type NodeOutcome } from "@/features/executions/types";
import { switchExecutor } from "./executor";
import { SWITCH_DEFAULT_OUTPUT } from "./handles";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as any;
const publish = (async () => {}) as any;

const run = async (
  data: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<NodeOutcome> => {
  const result = await switchExecutor({
    data,
    nodeId: "s1",
    outputKey: "SWITCH_1",
    userId: "u1",
    context,
    step,
    publish,
  } as any);
  if (!isRouted(result)) throw new Error("expected a routed outcome");
  return result;
};

describe("switchExecutor routing", () => {
  it("routes to the first matching case", async () => {
    const outcome = await run(
      {
        cases: [
          { id: "a", field: "@<status>@", operator: "equals", value: "no" },
          { id: "b", field: "@<status>@", operator: "equals", value: "yes" },
        ],
      },
      { status: "yes" },
    );
    expect(outcome.outputs).toEqual(["b"]);
    // Records the matched branch label (the exec view rebuilds the criteria
    // table from config); the second case matched, so it's "Case 2".
    expect(outcome.context).toMatchObject({ SWITCH_1: { matched: "Case 2" } });
  });

  it("stops at the first match even if a later case also matches", async () => {
    const outcome = await run(
      {
        cases: [
          { id: "a", field: "@<n>@", operator: "greater_than", value: "1" },
          { id: "b", field: "@<n>@", operator: "greater_than", value: "2" },
        ],
      },
      { n: 5 },
    );
    expect(outcome.outputs).toEqual(["a"]);
  });

  it("routes to default when no case matches", async () => {
    const outcome = await run(
      {
        cases: [
          { id: "a", field: "@<status>@", operator: "equals", value: "no" },
        ],
      },
      { status: "yes" },
    );
    expect(outcome.outputs).toEqual([SWITCH_DEFAULT_OUTPUT]);
  });

  it("routes to default when there are no cases", async () => {
    const outcome = await run({ cases: [] }, { status: "yes" });
    expect(outcome.outputs).toEqual([SWITCH_DEFAULT_OUTPUT]);
    expect(outcome.context).toMatchObject({ status: "yes" });
    // Default branch records the label with no field/operator/value criteria.
    expect(outcome.context).toMatchObject({ SWITCH_1: { matched: "Default" } });
  });
});
