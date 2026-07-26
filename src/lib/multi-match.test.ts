import { describe, expect, it } from "vitest";
import z from "zod";
import { FAN_OUT_MARKER } from "@/inngest/fan-out";
import {
  MULTI_MATCH_MODES,
  multiMatchConfigFields,
  readFanOutSeed,
  selectSingleMatch,
} from "./multi-match";

describe("multiMatchConfigFields", () => {
  const schema = z.object({ ...multiMatchConfigFields }).passthrough();

  it("accepts every mode and coerces maxFanOutItems", () => {
    for (const mode of MULTI_MATCH_MODES) {
      expect(schema.parse({ onMultipleMatches: mode }).onMultipleMatches).toBe(
        mode,
      );
    }
    expect(schema.parse({ maxFanOutItems: "250" }).maxFanOutItems).toBe(250);
  });

  it("stays optional (pre-existing saved nodes carry neither key)", () => {
    expect(schema.parse({})).toEqual({});
  });

  it("offers first/last/each/error, in the order the dialog lists them", () => {
    expect([...MULTI_MATCH_MODES]).toEqual(["first", "last", "each", "error"]);
  });

  it("rejects unknown modes and out-of-range caps", () => {
    // "all" belongs to the heading/color modes, not this enum.
    expect(() => schema.parse({ onMultipleMatches: "all" })).toThrow();
    expect(() => schema.parse({ maxFanOutItems: 0 })).toThrow();
    expect(() => schema.parse({ maxFanOutItems: 1001 })).toThrow();
  });
});

describe("selectSingleMatch", () => {
  const rows = [{ n: "a" }, { n: "b" }, { n: "c" }];

  it("takes the bottom-most match in 'last', the topmost otherwise", () => {
    expect(selectSingleMatch(rows, "last")).toEqual({ n: "c" });
    expect(selectSingleMatch(rows, "first")).toEqual({ n: "a" });
    expect(selectSingleMatch(rows, "error")).toEqual({ n: "a" });
    // A node saved before the modes existed carries no value at all.
    expect(selectSingleMatch(rows, undefined)).toEqual({ n: "a" });
  });

  it("returns undefined when nothing matched, in every mode", () => {
    for (const mode of MULTI_MATCH_MODES) {
      expect(selectSingleMatch([], mode)).toBeUndefined();
    }
  });

  it("returns the only match when exactly one did", () => {
    expect(selectSingleMatch([{ n: "a" }], "last")).toEqual({ n: "a" });
  });

  it("works on index lists (what update_row selects its write target from)", () => {
    expect(selectSingleMatch([0, 4, 9], "last")).toBe(9);
    // Index 0 is falsy — it must still come back as the chosen match.
    expect(selectSingleMatch([0, 4, 9], "first")).toBe(0);
  });
});

describe("readFanOutSeed", () => {
  const seed = {
    item: { Email: "a@x.com" },
    index: 1,
    total: 3,
    __fanOut: true,
  };

  it("returns the seed planted under the node's own output key", () => {
    expect(readFanOutSeed({ K: seed }, "K")).toBe(seed);
  });

  it("returns null for normal outputs, missing keys, and foreign seeds", () => {
    expect(readFanOutSeed({ K: { matchCount: 2 } }, "K")).toBeNull();
    expect(readFanOutSeed({}, "K")).toBeNull();
    // A seed under a DIFFERENT node's key is not ours to consume.
    expect(readFanOutSeed({ OTHER: seed }, "K")).toBeNull();
  });

  it("agrees with the engine's marker constant", () => {
    expect(seed[FAN_OUT_MARKER as "__fanOut"]).toBe(true);
  });
});
