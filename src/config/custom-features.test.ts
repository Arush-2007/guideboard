import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { getCustomFeatures } from "./custom-features";

describe("getCustomFeatures", () => {
  it("returns the Serial Number feature for the Google Sheets action", () => {
    const features = getCustomFeatures(NodeType.GOOGLE_SHEETS_ACTION);
    expect(features.map((f) => f.id)).toContain("serialNumber");
  });

  it("returns an empty list for a node type with no custom features", () => {
    expect(getCustomFeatures(NodeType.SLACK)).toEqual([]);
  });

  it("returns an empty list for nullish input", () => {
    expect(getCustomFeatures(null)).toEqual([]);
    expect(getCustomFeatures(undefined)).toEqual([]);
  });
});
