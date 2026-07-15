import { describe, expect, it } from "vitest";
import z from "zod";
import { FAN_OUT_MARKER } from "@/inngest/fan-out";
import { multiMatchConfigFields, readFanOutSeed } from "./multi-match";

describe("multiMatchConfigFields", () => {
  const schema = z.object({ ...multiMatchConfigFields }).passthrough();

  it("accepts all three modes and coerces maxFanOutItems", () => {
    for (const mode of ["first", "each", "error"]) {
      expect(schema.parse({ onMultipleMatches: mode }).onMultipleMatches).toBe(
        mode,
      );
    }
    expect(schema.parse({ maxFanOutItems: "250" }).maxFanOutItems).toBe(250);
  });

  it("stays optional (pre-existing saved nodes carry neither key)", () => {
    expect(schema.parse({})).toEqual({});
  });

  it("rejects unknown modes and out-of-range caps", () => {
    expect(() => schema.parse({ onMultipleMatches: "all" })).toThrow();
    expect(() => schema.parse({ maxFanOutItems: 0 })).toThrow();
    expect(() => schema.parse({ maxFanOutItems: 1001 })).toThrow();
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
