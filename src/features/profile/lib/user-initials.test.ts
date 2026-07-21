import { describe, expect, it } from "vitest";
import { userInitials } from "./user-initials";

describe("userInitials", () => {
  it("takes the first and last word of a full name", () => {
    expect(userInitials("Ada Lovelace", "ada@example.com")).toBe("AL");
    expect(userInitials("Jean Luc Picard", "jl@example.com")).toBe("JP");
  });

  it("takes two letters from a single-word name", () => {
    expect(userInitials("Prince", "p@example.com")).toBe("PR");
  });

  it("ignores stray whitespace rather than emitting a blank initial", () => {
    expect(userInitials("  Ada   Lovelace  ", "ada@example.com")).toBe("AL");
  });

  it("falls back to the email when there is no name at all", () => {
    expect(userInitials("", "zoe@example.com")).toBe("Z");
    expect(userInitials("   ", "zoe@example.com")).toBe("Z");
  });

  it("never returns an empty string", () => {
    expect(userInitials("", "")).toBe("?");
  });
});
