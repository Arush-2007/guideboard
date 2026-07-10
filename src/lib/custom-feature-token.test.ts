import { describe, expect, it } from "vitest";
import {
  encodeCustomFeatureToken,
  parseCustomFeatureToken,
} from "./custom-feature-token";

describe("custom feature token", () => {
  it("round-trips a featureId with params", () => {
    const token = encodeCustomFeatureToken("serialNumber", {
      start: 1,
      pad: 4,
    });
    expect(token).toBe("@<custom:serialNumber?start=1&pad=4>@");
    expect(parseCustomFeatureToken(token)).toEqual({
      featureId: "serialNumber",
      params: { start: "1", pad: "4" },
    });
  });

  it("encodes and parses a feature with no params", () => {
    expect(encodeCustomFeatureToken("serialNumber")).toBe(
      "@<custom:serialNumber>@",
    );
    expect(parseCustomFeatureToken("@<custom:serialNumber>@")).toEqual({
      featureId: "serialNumber",
      params: {},
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(
      parseCustomFeatureToken("  @<custom:serialNumber?start=2>@  "),
    ).toEqual({ featureId: "serialNumber", params: { start: "2" } });
  });

  it("returns null for a normal data path (not a custom token)", () => {
    expect(parseCustomFeatureToken("@<googleForm.responses.Name>@")).toBeNull();
  });

  it("returns null for empty featureId, non-tokens, and nullish input", () => {
    for (const v of ["", "hello", "@<custom:>@", undefined, null]) {
      expect(parseCustomFeatureToken(v as string | null | undefined)).toBeNull();
    }
  });

  it("does not treat a mixed value (token + text) as a token", () => {
    expect(parseCustomFeatureToken("Job @<custom:serialNumber>@")).toBeNull();
  });
});
