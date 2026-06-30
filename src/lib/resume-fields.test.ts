import { describe, expect, it } from "vitest";
import { extractResumeFields } from "./resume-fields";

const sample = `Ada Lovelace
ada.lovelace@example.com | +1 (555) 123-4567
https://github.com/ada  https://linkedin.com/in/ada

Experienced engineer skilled in React, TypeScript and Node.js.`;

describe("extractResumeFields", () => {
  it("extracts emails, phones and links", () => {
    const fields = extractResumeFields(sample);
    expect(fields.emails).toContain("ada.lovelace@example.com");
    expect(fields.phones.length).toBeGreaterThan(0);
    expect(fields.links).toContain("https://github.com/ada");
    expect(fields.links).toContain("https://linkedin.com/in/ada");
  });

  it("matches configured skill keywords case-insensitively", () => {
    const fields = extractResumeFields(sample, ["react", "typescript", "Rust"]);
    expect(fields.matchedSkills).toEqual(
      expect.arrayContaining(["react", "typescript"]),
    );
    expect(fields.matchedSkills).not.toContain("Rust");
  });

  it("is safe on empty input", () => {
    const fields = extractResumeFields("", ["react"]);
    expect(fields).toEqual({
      emails: [],
      phones: [],
      links: [],
      matchedSkills: [],
    });
  });
});
