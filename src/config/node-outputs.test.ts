import { describe, expect, it } from "vitest";
import { nodeOutputs } from "./node-outputs";

describe("nodeOutputs registry invariants", () => {
  it("declares each field path at most ONCE per node type", () => {
    // `pickIf` scopes which fields the variable PICKER offers, but the
    // execution page's friendly views resolve fields by path alone
    // (resolveFields / describePath in friendly-output.ts do not consult it).
    // So two entries sharing a path — e.g. one Sheets action's "Appended row"
    // and another's "Updated row", both at `rowByHeader` — would render the
    // same value twice in a run's output and mislabel it in the input view.
    // Actions that emit the same key must share ONE entry.
    const offenders: string[] = [];

    for (const [type, descriptor] of Object.entries(nodeOutputs)) {
      if (!descriptor) continue;
      const seen = new Set<string>();
      for (const field of descriptor.fields) {
        if (seen.has(field.path)) {
          offenders.push(`${type}.${field.path}`);
        }
        seen.add(field.path);
      }
    }

    expect(offenders).toEqual([]);
  });
});
