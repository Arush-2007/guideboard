import { describe, expect, it } from "vitest";
import { resolveFailureCause } from "./failure-email";

describe("resolveFailureCause", () => {
  it("passes the real error through when a node recorded", () => {
    // A node that throws is recorded FAILED with its message, stack and input
    // before the throw propagates, so the raw error IS the useful one — the
    // executions page can show exactly which node and why.
    expect(resolveFailureCause(3, "Gmail Action node: To is required")).toBe(
      "Gmail Action node: To is required",
    );
  });

  it("explains the absence when nothing recorded", () => {
    const message = resolveFailureCause(0, "function run timed out");

    // Zero rows means the run never reached the engine's failure path at all:
    // the platform ended the invocation, or it died before the first node. The
    // old behaviour showed a failed run with an empty node list and "function
    // run timed out" — true, and no help.
    expect(message).toContain("cause unknown");
    expect(message).toContain("no per-node detail");
    // Names the likely causes, so the absence of detail reads as information
    // rather than as something broken.
    expect(message).toMatch(/time limit or out of memory/);
    expect(message).toMatch(/cycle/);
    // And never loses the original.
    expect(message).toContain("function run timed out");
  });

  it("treats a single recorded node as enough detail", () => {
    // Boundary: one row is enough to point at a node, so no explanation is added.
    expect(resolveFailureCause(1, "boom")).toBe("boom");
  });
});
