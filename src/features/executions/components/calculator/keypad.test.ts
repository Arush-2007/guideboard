import { describe, expect, it } from "vitest";
import { applyBackspace, nextBracket, toReadableExpression } from "./keypad";

describe("toReadableExpression", () => {
  it("unwraps references to their bare path", () => {
    expect(toReadableExpression("@<SHEETS_1.price>@ * 1.18")).toBe(
      "SHEETS_1.price × 1.18",
    );
  });

  it("prints operators the way a calculator does", () => {
    expect(toReadableExpression("6 * 2 / 3")).toBe("6 × 2 ÷ 3");
  });

  it("handles several references", () => {
    expect(toReadableExpression("@<a.x>@ + @<b.y>@")).toBe("a.x + b.y");
  });

  it("is safe on empty and undefined input", () => {
    expect(toReadableExpression("")).toBe("");
    expect(toReadableExpression(undefined)).toBe("");
  });

  it("leaves a plain expression alone", () => {
    expect(toReadableExpression("2 + 3")).toBe("2 + 3");
  });
});

describe("applyBackspace", () => {
  it("deletes the character before the caret", () => {
    expect(applyBackspace("123", 3, 3)).toEqual({ value: "12", caret: 2 });
  });

  it("deletes from the middle, leaving the tail intact", () => {
    expect(applyBackspace("1234", 2, 2)).toEqual({ value: "134", caret: 1 });
  });

  it("deletes a selection", () => {
    expect(applyBackspace("123456", 1, 4)).toEqual({ value: "156", caret: 1 });
  });

  it("does nothing at the start of the expression", () => {
    expect(applyBackspace("123", 0, 0)).toEqual({ value: "123", caret: 0 });
  });

  it("is a no-op on an empty expression", () => {
    expect(applyBackspace("", 0, 0)).toEqual({ value: "", caret: 0 });
  });

  describe("references delete as one entry", () => {
    // Chipping a `@<...>@` token apart leaves something that still LOOKS like a
    // reference but no longer resolves — it would silently read as text at run
    // time, which is worse than the delete not working.
    it("removes a whole reference in one press", () => {
      expect(applyBackspace("1 + @<a.b>@", 11, 11)).toEqual({
        value: "1 + ",
        caret: 4,
      });
    });

    it("removes a reference sitting mid-expression", () => {
      expect(applyBackspace("@<a.b>@ + 2", 7, 7)).toEqual({
        value: " + 2",
        caret: 0,
      });
    });

    it("only swallows the token when the caret is right after it", () => {
      // Caret is one char further along, past the trailing space.
      expect(applyBackspace("@<a.b>@ ", 8, 8)).toEqual({
        value: "@<a.b>@",
        caret: 7,
      });
    });

    it("does not treat a partial token as whole", () => {
      expect(applyBackspace("@<a.b", 5, 5)).toEqual({
        value: "@<a.",
        caret: 4,
      });
    });
  });

  describe("out-of-range carets", () => {
    it("clamps a caret past the end", () => {
      expect(applyBackspace("12", 99, 99)).toEqual({ value: "1", caret: 1 });
    });

    it("clamps a negative caret", () => {
      expect(applyBackspace("12", -5, -5)).toEqual({ value: "12", caret: 0 });
    });
  });
});

describe("nextBracket", () => {
  it("opens when nothing is open", () => {
    expect(nextBracket("", 0)).toBe("(");
    expect(nextBracket("2 + 3", 5)).toBe("(");
  });

  it("closes an open bracket", () => {
    expect(nextBracket("(2 + 3", 6)).toBe(")");
  });

  it("opens again once brackets are balanced", () => {
    expect(nextBracket("(2 + 3)", 7)).toBe("(");
  });

  it("closes only the innermost of several open brackets", () => {
    expect(nextBracket("((1", 3)).toBe(")");
  });

  it("counts only brackets BEFORE the caret", () => {
    // The caret is at the very start, in front of the open bracket — typing `)`
    // there would produce `)(2 + 3`, which is nonsense.
    expect(nextBracket("(2 + 3", 0)).toBe("(");
  });

  it("clamps an out-of-range caret", () => {
    expect(nextBracket("(1", 99)).toBe(")");
    expect(nextBracket("(1", -1)).toBe("(");
  });
});
