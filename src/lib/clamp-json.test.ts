import { describe, expect, it } from "vitest";
import { type ClampedMarker, clampJson } from "./clamp-json";

const isMarker = (v: unknown): v is ClampedMarker =>
  typeof v === "object" &&
  v !== null &&
  (v as ClampedMarker).__truncated === true;

describe("clampJson", () => {
  it("returns small values unchanged", () => {
    const value = { a: 1, b: "hello", c: [1, 2, 3] };
    expect(clampJson(value)).toBe(value);
  });

  it("returns a truncation marker when over the cap", () => {
    const big = { blob: "x".repeat(50_000) };
    const result = clampJson(big);
    expect(isMarker(result)).toBe(true);
    if (isMarker(result)) {
      expect(result.bytes).toBeGreaterThan(32_768);
      expect(result.preview.length).toBeLessThan(1_100);
    }
  });

  it("respects a custom maxBytes", () => {
    expect(clampJson({ a: "12345" }, 4)).not.toBe({ a: "12345" });
    expect(isMarker(clampJson({ a: "12345" }, 4))).toBe(true);
    expect(clampJson({ a: 1 }, 10_000)).toEqual({ a: 1 });
  });

  it("collapses unserializable values to a marker instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = clampJson(cyclic);
    expect(isMarker(result)).toBe(true);
    if (isMarker(result)) expect(result.bytes).toBe(-1);
  });

  it("maps undefined to null", () => {
    expect(clampJson(undefined)).toBeNull();
  });
});
