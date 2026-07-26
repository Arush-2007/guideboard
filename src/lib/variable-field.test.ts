import { describe, expect, it } from "vitest";
import {
  applyPickedToken,
  hasPlaceholder,
  splitPlaceholders,
  triggerRangeBefore,
} from "@/lib/variable-field";

describe("triggerRangeBefore", () => {
  it("finds the trigger the user just typed", () => {
    expect(triggerRangeBefore("Hi @<", 5)).toEqual({ start: 3, end: 5 });
  });

  it("ignores a trigger that is not against the caret", () => {
    expect(triggerRangeBefore("Hi @< there", 11)).toBeNull();
  });

  it("ignores a lone @ and a missing caret", () => {
    expect(triggerRangeBefore("Hi @", 4)).toBeNull();
    expect(triggerRangeBefore("Hi @<", null)).toBeNull();
    expect(triggerRangeBefore("@", 1)).toBeNull();
  });

  it("fires at the very start of an empty field", () => {
    expect(triggerRangeBefore("@<", 2)).toEqual({ start: 0, end: 2 });
  });
});

describe("splitPlaceholders", () => {
  it("separates tokens from the prose around them", () => {
    expect(splitPlaceholders("Hi @<AI_TEXT_1.output>@!")).toEqual([
      { text: "Hi ", isToken: false },
      { text: "@<AI_TEXT_1.output>@", isToken: true },
      { text: "!", isToken: false },
    ]);
  });

  it("handles back-to-back tokens and a token-only value", () => {
    expect(splitPlaceholders("@<A.a>@@<B.b>@")).toEqual([
      { text: "@<A.a>@", isToken: true },
      { text: "@<B.b>@", isToken: true },
    ]);
  });

  it("returns plain text untouched and nothing for an empty value", () => {
    expect(splitPlaceholders("no tokens here")).toEqual([
      { text: "no tokens here", isToken: false },
    ]);
    expect(splitPlaceholders("")).toEqual([]);
  });

  it("always reproduces the input when concatenated", () => {
    for (const value of [
      "",
      "plain",
      "@<A.a>@",
      "a @<A.a>@ b @<B.b>@",
      "half open @< and @ alone",
    ]) {
      expect(
        splitPlaceholders(value)
          .map((s) => s.text)
          .join(""),
      ).toBe(value);
    }
  });
});

describe("applyPickedToken", () => {
  const token = "@<AI_TEXT_1.output>@";

  it("consumes the trigger that opened the picker", () => {
    // "Hi @<" with the caret at the end.
    expect(
      applyPickedToken(
        "Hi @<",
        token,
        { start: 5, end: 5 },
        {
          start: 3,
          end: 5,
        },
      ),
    ).toEqual({ value: `Hi ${token}`, caret: 3 + token.length });
  });

  it("inserts at the caret when there is no trigger", () => {
    expect(applyPickedToken("Hi !", token, { start: 3, end: 3 }, null)).toEqual(
      { value: `Hi ${token}!`, caret: 3 + token.length },
    );
  });

  it("replaces the selection when there is no trigger", () => {
    expect(
      applyPickedToken("Hi name!", token, { start: 3, end: 7 }, null),
    ).toEqual({ value: `Hi ${token}!`, caret: 3 + token.length });
  });

  it("falls back to the caret when the recorded trigger is stale", () => {
    // The `@<` the trigger points at is gone — the range now covers "na".
    expect(
      applyPickedToken(
        "Hi name",
        token,
        { start: 7, end: 7 },
        {
          start: 3,
          end: 5,
        },
      ),
    ).toEqual({ value: `Hi name${token}`, caret: 7 + token.length });
  });

  it("appends when the caret is at the end of an empty value", () => {
    expect(applyPickedToken("", token, { start: 0, end: 0 }, null)).toEqual({
      value: token,
      caret: token.length,
    });
  });
});

describe("hasPlaceholder", () => {
  it("reports only complete tokens, repeatably", () => {
    expect(hasPlaceholder("@<A.a>@")).toBe(true);
    // Twice: a global regex driven with `test` would flip to false here.
    expect(hasPlaceholder("@<A.a>@")).toBe(true);
    expect(hasPlaceholder("@< unfinished")).toBe(false);
    expect(hasPlaceholder("")).toBe(false);
  });
});
