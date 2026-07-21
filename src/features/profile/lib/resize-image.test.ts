import { describe, expect, it } from "vitest";
import { centerCropRect } from "./resize-image";

// Only the geometry is covered — the rest of `resizeAvatar` is canvas plumbing
// that a Node test environment can't exercise meaningfully. The arithmetic is
// what would silently produce squashed or off-centre faces.
describe("centerCropRect", () => {
  it("takes the whole frame when the source is already square", () => {
    expect(centerCropRect(800, 800)).toEqual({ x: 0, y: 0, size: 800 });
  });

  it("trims the sides of a landscape source", () => {
    expect(centerCropRect(1600, 900)).toEqual({ x: 350, y: 0, size: 900 });
  });

  it("trims the top and bottom of a portrait source", () => {
    expect(centerCropRect(900, 1600)).toEqual({ x: 0, y: 350, size: 900 });
  });

  it("rounds rather than emitting a fractional offset", () => {
    // A 1px odd overhang can't be split evenly; it must still land on integers.
    expect(centerCropRect(101, 100)).toEqual({ x: 1, y: 0, size: 100 });
  });

  it("never crops outside the source", () => {
    for (const [w, h] of [
      [1, 4000],
      [4000, 1],
      [3, 2],
    ]) {
      const { x, y, size } = centerCropRect(w, h);
      expect(x + size).toBeLessThanOrEqual(w);
      expect(y + size).toBeLessThanOrEqual(h);
    }
  });
});
