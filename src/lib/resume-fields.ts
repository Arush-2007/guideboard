/**
 * Pure heuristic extraction of structured fields from raw resume text, used by
 * the `RESUME_PARSER` node's built-in provider. Kept React/IO-free so it can be
 * unit-tested directly; the executor handles the (impure) file fetch separately
 * in `resume-fetch.ts`.
 */

export type ResumeFields = {
  emails: string[];
  phones: string[];
  links: string[];
  /** Skills from the configured keyword list that appear in the text. */
  matchedSkills: string[];
};

// Deliberately conservative regexes — recall over precision is fine here since
// these are surfaced as hints, and the raw text remains available downstream.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/gi;

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function extractResumeFields(
  text: string,
  skillKeywords: string[] = [],
): ResumeFields {
  const safe = text ?? "";
  const haystack = safe.toLowerCase();

  const matchedSkills = dedupe(
    skillKeywords
      .map((k) => k.trim())
      .filter((k) => k && haystack.includes(k.toLowerCase())),
  );

  return {
    emails: dedupe(safe.match(EMAIL_RE) ?? []),
    phones: dedupe(
      (safe.match(PHONE_RE) ?? []).filter(
        (p) => p.replace(/\D/g, "").length >= 8,
      ),
    ),
    links: dedupe(safe.match(URL_RE) ?? []),
    matchedSkills,
  };
}
