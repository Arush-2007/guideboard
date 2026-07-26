import { describe, expect, it } from "vitest";
import { normalizeResponseKeys } from "./form-responses";

describe("normalizeResponseKeys", () => {
  // The real payload that silently rendered two mapped columns empty: the Apps
  // Script keyed by the raw title, the picker's path used the trimmed one.
  it("trims keys so a title with a stray space is reachable", () => {
    const out = normalizeResponseKeys({
      Name: "Arav jain",
      "Vehicle Name or Model ": "Baleno-Top Model",
      "Work or Issue to visit ": "Puncture",
    });
    expect(out["Vehicle Name or Model"]).toBe("Baleno-Top Model");
    expect(out["Work or Issue to visit"]).toBe("Puncture");
    expect(out.Name).toBe("Arav jain");
    // The unreachable raw keys are gone, not merely duplicated.
    expect(out["Vehicle Name or Model "]).toBeUndefined();
  });

  it("handles leading whitespace and drops whitespace-only keys", () => {
    const out = normalizeResponseKeys({ "  Km ": "169000", "   ": "orphan" });
    expect(out.Km).toBe("169000");
    expect(Object.keys(out)).toEqual(["Km"]);
  });

  it("a whitespace-only duplicate cannot wipe a real answer", () => {
    expect(normalizeResponseKeys({ Name: "Ada", "Name ": "" }).Name).toBe(
      "Ada",
    );
    // …and a blank first value yields to the real one.
    expect(normalizeResponseKeys({ "Name ": "", Name: "Ada" }).Name).toBe(
      "Ada",
    );
  });

  it("leaves an already-clean payload untouched", () => {
    const clean = { Name: "Ada", Amount: "10" };
    expect(normalizeResponseKeys(clean)).toEqual(clean);
  });

  it("is safe on a missing or non-object payload", () => {
    expect(normalizeResponseKeys(undefined)).toEqual({});
    expect(normalizeResponseKeys(null)).toEqual({});
    expect(normalizeResponseKeys("nope")).toEqual({});
    expect(normalizeResponseKeys([1, 2])).toEqual({});
  });
});
