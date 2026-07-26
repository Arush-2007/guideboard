import { describe, expect, it } from "vitest";
import {
  ExpressionError,
  evaluateExpression,
  toPlainDecimal,
  tryEvaluateExpression,
} from "./expression";

describe("evaluateExpression", () => {
  describe("arithmetic and precedence", () => {
    it("adds and subtracts left to right", () => {
      expect(evaluateExpression("1 + 2 + 3")).toBe(6);
      expect(evaluateExpression("10 - 3 - 2")).toBe(5);
    });

    it("gives * and / higher precedence than + and -", () => {
      // The single most important behaviour to get right: a calculator that
      // answered 20 here would be silently wrong on every invoice total.
      expect(evaluateExpression("2 + 3 * 4")).toBe(14);
      expect(evaluateExpression("2 + 8 / 4")).toBe(4);
      expect(evaluateExpression("10 - 2 * 3")).toBe(4);
    });

    it("divides left to right, not right to left", () => {
      expect(evaluateExpression("100 / 10 / 2")).toBe(5);
    });

    it("lets brackets override precedence", () => {
      expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
      expect(evaluateExpression("((1 + 2) * (3 + 4)) - 1")).toBe(20);
    });

    it("treats % as modulo, at the same precedence as * and /", () => {
      expect(evaluateExpression("10 % 3")).toBe(1);
      expect(evaluateExpression("2 + 10 % 3")).toBe(3);
      expect(evaluateExpression("10 % 4 * 2")).toBe(4);
    });

    it("handles decimals", () => {
      expect(evaluateExpression("1.5 * 2")).toBe(3);
      expect(evaluateExpression("0.5 + 0.25")).toBe(0.75);
      expect(evaluateExpression(".5 * 4")).toBe(2);
    });
  });

  describe("unary signs", () => {
    it("negates a literal", () => {
      expect(evaluateExpression("-5")).toBe(-5);
      expect(evaluateExpression("-5 + 3")).toBe(-2);
    });

    it("handles a negative right-hand operand", () => {
      expect(evaluateExpression("1 - -3")).toBe(4);
      expect(evaluateExpression("2 * -3")).toBe(-6);
    });

    it("handles stacked and explicit-positive signs", () => {
      expect(evaluateExpression("--5")).toBe(5);
      expect(evaluateExpression("+5")).toBe(5);
      expect(evaluateExpression("-(2 + 3)")).toBe(-5);
    });

    it("binds unary minus tighter than binary operators", () => {
      expect(evaluateExpression("-2 * 3")).toBe(-6);
    });
  });

  describe("functions", () => {
    it("rounds to the nearest whole number", () => {
      expect(evaluateExpression("round(2.4)")).toBe(2);
      expect(evaluateExpression("round(2.6)")).toBe(3);
    });

    it("rounds to a given number of decimal places", () => {
      expect(evaluateExpression("round(3.14159, 2)")).toBe(3.14);
      expect(evaluateExpression("round(2.005, 2)")).toBe(2.01);
      expect(evaluateExpression("round(1234.5678, 0)")).toBe(1235);
    });

    it("rounds decimal halves up, despite binary floating point", () => {
      // Regression: rounding by multiplying (`1.005 * 100`) gives
      // 100.49999999999999, so these rounded DOWN — 1.005 came out as 1 where
      // every spreadsheet, and the user, says 1.01.
      expect(evaluateExpression("round(1.005, 2)")).toBe(1.01);
      expect(evaluateExpression("round(2.675, 2)")).toBe(2.68);
      expect(evaluateExpression("round(8.165, 2)")).toBe(8.17);
    });

    it("supports floor, ceil and abs", () => {
      expect(evaluateExpression("floor(2.9)")).toBe(2);
      expect(evaluateExpression("ceil(2.1)")).toBe(3);
      expect(evaluateExpression("abs(-7)")).toBe(7);
      expect(evaluateExpression("floor(-2.1)")).toBe(-3);
    });

    it("accepts a full expression as an argument, and nests", () => {
      expect(evaluateExpression("round(10 / 3, 2)")).toBe(3.33);
      expect(evaluateExpression("abs(floor(-4.5))")).toBe(5);
    });

    it("is case-insensitive about function names", () => {
      expect(evaluateExpression("ROUND(2.6)")).toBe(3);
    });

    it("composes with surrounding arithmetic", () => {
      expect(evaluateExpression("round(2.4) + 10")).toBe(12);
      expect(evaluateExpression("2 * round(1.6)")).toBe(4);
    });
  });

  describe("floating-point presentation", () => {
    it("absorbs binary floating-point noise", () => {
      // Raw IEEE-754 gives 0.30000000000000004 here.
      expect(evaluateExpression("0.1 + 0.2")).toBe(0.3);
      expect(evaluateExpression("1.1 * 3")).toBe(3.3);
    });

    it("still returns exact whole numbers", () => {
      expect(evaluateExpression("2 + 2")).toBe(4);
      expect(evaluateExpression("0")).toBe(0);
    });

    it("does not damage values needing real precision", () => {
      expect(evaluateExpression("123456.789")).toBe(123456.789);
    });

    it("preserves large integers exactly", () => {
      // Regression: rounding to 12 significant digits silently corrupted these.
      // `1234567890123 + 1` returned 1234567890120 and `999999999999999` came
      // back as 1000000000000000 — a wrong total with no error, which is the
      // worst way for a calculator to fail.
      expect(evaluateExpression("1234567890123 + 1")).toBe(1234567890124);
      expect(evaluateExpression("999999999999999")).toBe(999999999999999);
      expect(evaluateExpression("123456789012345")).toBe(123456789012345);
      expect(evaluateExpression("999999999999 * 1000")).toBe(999999999999000);
    });
  });

  describe("modulo sign", () => {
    // JS remainder semantics — the result takes the sign of the DIVIDEND. This
    // is what "% as in code" means, and it is deliberate.
    it("takes the sign of the left operand", () => {
      expect(evaluateExpression("-10 % 3")).toBe(-1);
      expect(evaluateExpression("10 % -3")).toBe(1);
      expect(evaluateExpression("-10 % -3")).toBe(-1);
    });
  });

  describe("errors", () => {
    const messageFor = (expression: string) => {
      try {
        evaluateExpression(expression);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(`Expected "${expression}" to throw`);
    };

    it("throws ExpressionError, not a bare Error", () => {
      expect(() => evaluateExpression("1 +")).toThrow(ExpressionError);
    });

    it("rejects an empty expression", () => {
      expect(messageFor("")).toMatch(/nothing to calculate/i);
      expect(messageFor("   ")).toMatch(/nothing to calculate/i);
    });

    it("rejects division and modulo by zero", () => {
      expect(messageFor("1 / 0")).toMatch(/divide by zero/i);
      expect(messageFor("1 % 0")).toMatch(/remainder with zero/i);
      expect(messageFor("1 / (3 - 3)")).toMatch(/divide by zero/i);
    });

    it("rejects unbalanced brackets in either direction", () => {
      expect(messageFor("(1 + 2")).toMatch(/unclosed bracket/i);
      expect(messageFor("1 + 2)")).toMatch(/no opening bracket/i);
    });

    it("rejects a dangling operator", () => {
      expect(messageFor("1 +")).toMatch(/ends unexpectedly/i);
      expect(messageFor("* 5")).toMatch(/missing a number/i);
    });

    it("rejects unknown characters and names", () => {
      expect(messageFor("1 & 2")).toMatch(/isn't something this calculator/i);
      expect(messageFor("sqrt(4)")).toMatch(/isn't something this calculator/i);
    });

    it("names the available functions when one is unknown", () => {
      expect(messageFor("sqrt(4)")).toContain("round");
    });

    it("rejects malformed numbers", () => {
      expect(messageFor("1.2.3")).toMatch(/more than one decimal point/i);
      expect(messageFor("1 + .")).toMatch(/stray decimal point/i);
    });

    it("rejects a bad round() precision", () => {
      expect(messageFor("round(1.5, 2.5)")).toMatch(
        /whole number from 0 to 100/i,
      );
      expect(messageFor("round(1.5, -1)")).toMatch(
        /whole number from 0 to 100/i,
      );
    });

    it("rejects a second argument to a single-argument function", () => {
      expect(messageFor("abs(1, 2)")).toMatch(/just one number/i);
    });

    it("rejects a function name without brackets", () => {
      expect(messageFor("round 2")).toMatch(/expected an opening bracket/i);
    });

    it("rejects two numbers with no operator between them", () => {
      expect(messageFor("2 3")).toMatch(/unexpected "3"/i);
    });

    it("never returns a non-finite number, even when rounding overflows", () => {
      // Regression: the finiteness guard ran BEFORE the significant-digit
      // rounding, and `Number(Number.MAX_VALUE.toPrecision(15))` is Infinity.
      // An Infinity returned from here reached the executor, where
      // JSON.stringify turns it into null — a silent null in the run output
      // while the node reported success.
      const nearMax = `17976931348623157${"0".repeat(292)}`; // ≈ MAX_VALUE
      expect(() => evaluateExpression(nearMax)).toThrow(
        /too large to represent/i,
      );
    });

    it("rounds a huge value instead of failing on an overflowing shift", () => {
      // Regression: round()'s internal exponent shift overflowed to Infinity
      // and came back NaN, so a representable number that needed no rounding
      // was reported as "too large to represent".
      const huge = `1${"0".repeat(300)}`;
      expect(evaluateExpression(`round(${huge}, 2)`)).toBe(1e300);
      expect(evaluateExpression(`round(${huge})`)).toBe(1e300);
    });

    it("reports a result too large to represent", () => {
      // Beyond Number.MAX_VALUE (~1.8e308), so this overflows to Infinity.
      // Written out longhand because there is no exponent key on the keypad —
      // `1e308` would trip the unknown-name check on the `e` instead, which
      // would leave the overflow branch untested.
      const tooBig = `1${"0".repeat(309)}`;
      expect(messageFor(tooBig)).toMatch(/too large to represent/i);
      expect(messageFor(`${tooBig} * 10`)).toMatch(/too large to represent/i);
    });

    it("explains that scientific notation isn't supported", () => {
      expect(messageFor("1e5")).toMatch(/isn't something this calculator/i);
    });
  });
});

describe("toPlainDecimal", () => {
  it("leaves an ordinary number as-is", () => {
    expect(toPlainDecimal(42)).toBe("42");
    expect(toPlainDecimal(3.3)).toBe("3.3");
    expect(toPlainDecimal(0)).toBe("0");
    expect(toPlainDecimal(-0.5)).toBe("-0.5");
  });

  it("expands small numbers JS would print exponentially", () => {
    expect(toPlainDecimal(1e-7)).toBe("0.0000001");
    expect(toPlainDecimal(1.5e-9)).toBe("0.0000000015");
    expect(toPlainDecimal(-1e-8)).toBe("-0.00000001");
  });

  it("expands large numbers JS would print exponentially", () => {
    expect(toPlainDecimal(1e21)).toBe("1000000000000000000000");
    expect(toPlainDecimal(1.2345e25)).toBe("12345000000000000000000000");
  });

  it("never emits exponent notation, and always round-trips", () => {
    // The round-trip is the property that matters: the executor substitutes
    // this string back into an expression, so it must parse to the SAME double.
    for (const value of [1e-7, 1e21, 1e22, 1.5e-9, -2.5e-11, 5e-324, 42, 0.5]) {
      const plain = toPlainDecimal(value);
      expect(plain, `${value} still exponential`).not.toMatch(/e/i);
      expect(Number(plain), `${value} failed to round-trip`).toBe(value);
    }
  });

  it("gives the shortest form, not the exact binary expansion", () => {
    // `(1e-7).toFixed(100)` would yield 0.000000099999999999999995474…
    expect(toPlainDecimal(1e-7)).toBe("0.0000001");
  });
});

describe("tryEvaluateExpression", () => {
  it("returns the value for a valid expression", () => {
    expect(tryEvaluateExpression("2 + 3 * 4")).toEqual({
      value: 14,
      error: null,
    });
  });

  it("returns the message for an invalid one", () => {
    const attempt = tryEvaluateExpression("1 / 0");
    expect(attempt.value).toBeNull();
    expect(attempt.error).toMatch(/divide by zero/i);
  });

  it("does not throw on any input", () => {
    expect(() => tryEvaluateExpression("((((")).not.toThrow();
    expect(() => tryEvaluateExpression("")).not.toThrow();
    expect(() => tryEvaluateExpression("!!!")).not.toThrow();
  });

  // Regression: this ran inside a render-path useMemo and rethrew anything that
  // wasn't an ExpressionError, so a stack overflow from a deeply nested paste
  // escaped as a render error and took the editor down.
  it("reports deep nesting instead of throwing RangeError", () => {
    const deep = `${"(".repeat(50_000)}1${")".repeat(50_000)}`;
    let attempt: ReturnType<typeof tryEvaluateExpression> | undefined;
    expect(() => {
      attempt = tryEvaluateExpression(deep);
    }).not.toThrow();
    expect(attempt?.value).toBeNull();
    expect(attempt?.error).toBeTruthy();
  });
});
