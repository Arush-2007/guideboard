import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { getExecutor } from "./executor-registry";

describe("executor registry", () => {
  // The executor contract: every NodeType must resolve to a callable executor,
  // so executeWorkflow never throws "No executor found" mid-run.
  it("resolves an executor for every NodeType", () => {
    for (const type of Object.values(NodeType)) {
      const executor = getExecutor(type);
      expect(typeof executor).toBe("function");
    }
  });

  it("throws for an unregistered node type", () => {
    expect(() => getExecutor("NOT_A_REAL_TYPE" as NodeType)).toThrow(
      /No executor found/,
    );
  });
});
