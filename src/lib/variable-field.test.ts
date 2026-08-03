import { describe, expect, it } from "vitest";
import {
  applyPickedToken,
  hasPlaceholder,
  splitPlaceholders,
  triggerRangeBefore,
} from "@/lib/variable-field";

describe("triggerRangeBefore", () => {
  it("finds the trigger the user just typed, with an empty query", () => {
    expect(triggerRangeBefore("Hi @<", 5)).toEqual({
      start: 3,
      end: 5,
      query: "",
    });
  });

  it("carries what has been typed since, and covers it", () => {
    // `end` is the caret, so the range spans `@<OG_S` — a pick has to replace
    // the half-typed name too, not just the two trigger characters.
    expect(triggerRangeBefore("Hi @<OG_S", 9)).toEqual({
      start: 3,
      end: 9,
      query: "OG_S",
    });
  });

  it("keeps the dotted field part in the query", () => {
    expect(triggerRangeBefore("@<og_sheets.j", 13)?.query).toBe("og_sheets.j");
  });

  it("stops at the punctuation that ends a reference", () => {
    // A finished token further back is not an invitation to keep typing into.
    expect(triggerRangeBefore("@<A.a>@ then", 12)).toBeNull();
    // A second `@` means the first reference is over.
    expect(triggerRangeBefore("@<A.a>@x", 8)).toBeNull();
  });

  it("does not reach across a newline", () => {
    expect(triggerRangeBefore("@<og\nsheets", 11)).toBeNull();
  });

  it("stops at a space, so an abandoned trigger stops claiming the line", () => {
    // Without this the query would be " team": the panel would go on filtering
    // while the user writes prose, Enter would stay captured (so a textarea
    // would stop accepting newlines), and a pick would overwrite from the stray
    // `@<` onwards — deleting the words typed after it.
    expect(triggerRangeBefore("Hi @< team", 10)).toBeNull();
    expect(triggerRangeBefore("Hi @<og sheets", 14)).toBeNull();
  });

  it("still fires on the trigger typed at the end of a word", () => {
    // The space rule must not cost the ordinary case of writing a sentence and
    // then starting a reference.
    expect(triggerRangeBefore("Hi @<og", 7)).toEqual({
      start: 3,
      end: 7,
      query: "og",
    });
  });

  it("attaches to the NEAREST opener when a finished token precedes it", () => {
    const value = "@<A.a>@ and @<og";
    expect(triggerRangeBefore(value, value.length)).toEqual({
      start: 12,
      end: 16,
      query: "og",
    });
  });

  it("ignores a lone @ and a missing caret", () => {
    expect(triggerRangeBefore("Hi @", 4)).toBeNull();
    expect(triggerRangeBefore("Hi @<", null)).toBeNull();
    expect(triggerRangeBefore("@", 1)).toBeNull();
  });

  it("fires at the very start of an empty field", () => {
    expect(triggerRangeBefore("@<", 2)).toEqual({
      start: 0,
      end: 2,
      query: "",
    });
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
        { start: 3, end: 5, query: "" },
      ),
    ).toEqual({ value: `Hi ${token}`, caret: 3 + token.length });
  });

  it("consumes the half-typed name along with the trigger", () => {
    // The whole point of the range covering the query: picking after typing
    // `@<og_s` must not leave `@<og_s` sitting in front of the token.
    expect(
      applyPickedToken(
        "Hi @<og_s",
        token,
        { start: 9, end: 9 },
        { start: 3, end: 9, query: "og_s" },
      ),
    ).toEqual({ value: `Hi ${token}`, caret: 3 + token.length });
  });

  it("falls back to the caret when the query has since been closed off", () => {
    // The recorded range still points at a `@<`, but the text under it now holds
    // a `>` — the reference was finished by other means, so overwriting that
    // span would eat a complete token.
    expect(
      applyPickedToken(
        "Hi @<A.a>@",
        token,
        { start: 10, end: 10 },
        { start: 3, end: 10, query: "og_s" },
      ),
    ).toEqual({ value: `Hi @<A.a>@${token}`, caret: 10 + token.length });
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
        { start: 3, end: 5, query: "" },
      ),
    ).toEqual({ value: `Hi name${token}`, caret: 7 + token.length });
  });

  it("falls back to the caret once prose has been typed after the trigger", () => {
    // Recorded while the reference was live, then the user typed a space and
    // carried on. Honouring the stale range would delete " team".
    expect(
      applyPickedToken(
        "Hi @< team",
        token,
        { start: 10, end: 10 },
        { start: 3, end: 10, query: "" },
      ),
    ).toEqual({ value: `Hi @< team${token}`, caret: 10 + token.length });
  });

  it("falls back to the caret when the range runs past the value", () => {
    // Recorded against a longer value that has since been cut back.
    expect(
      applyPickedToken(
        "Hi @<",
        token,
        { start: 5, end: 5 },
        { start: 3, end: 40, query: "og_sheets" },
      ),
    ).toEqual({ value: `Hi @<${token}`, caret: 5 + token.length });
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
