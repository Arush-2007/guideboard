import { PLACEHOLDER_RE } from "@/lib/template-token";

/**
 * The authoring-side half of the `@<path>@` grammar: what a field editor needs
 * to know about the tokens sitting in its text. The grammar itself lives in one
 * place (`template-token.ts`) — this module only reads it.
 */

/**
 * What a user types to summon the field picker: the opening of a placeholder.
 * Typing it is the keyboard equivalent of clicking the braces button, and the
 * two characters are consumed by whatever field is then picked.
 */
export const PICKER_TRIGGER = "@<";

export type TriggerRange = {
  start: number;
  end: number;
  /**
   * What has been typed since the `@<`, which the picker narrows itself by.
   * Empty the instant the trigger is typed, and it grows as the user keeps
   * going: `@<OG_S` carries "OG_S".
   */
  query: string;
};

/**
 * Characters that end the search for an unfinished reference.
 *
 * `>` and `@` are the token's own closing punctuation — past either of them the
 * reference is finished, not being typed.
 *
 * WHITESPACE ends it too, and that is the rule that keeps an abandoned `@<` from
 * claiming the rest of the sentence. Because the search runs BACKWARDS from the
 * caret, without it "Hi @< team" reads as a live query of " team": the panel
 * would go on filtering while the user writes prose, ↑/↓/Enter would stay
 * captured (so a textarea would stop accepting newlines), and a pick would
 * overwrite from the stray `@<` onwards — deleting the words typed after it.
 *
 * A path may legitimately CONTAIN a space (`anchorRow.Job No` — `sanitizeHeaderKey`
 * strips only dots), and this does not stop such a field being reached: matching
 * normalizes separators away, so `jobno` and `job` both still find `Job No`. The
 * user never has to type the space, and typing one means they have moved on.
 */
const NOT_IN_PATH = /[>@\s]/;

/**
 * The unfinished `@<…` the caret currently sits inside, with everything typed
 * since it, or null.
 *
 * Anchored to the caret rather than searching the whole value: an already-written
 * `@<AI_TEXT_1.output>@` further along the line is a finished token, not an
 * invitation to open the picker. `end` is the caret, so the range covers the
 * `@<` AND the query — which is what a pick must replace. Replacing only the two
 * trigger characters would leave the half-typed name behind
 * (`@<og_s@<OG_Sheets.Job No>@`).
 */
export function triggerRangeBefore(
  value: string,
  caret: number | null | undefined,
): TriggerRange | null {
  if (caret == null || caret < PICKER_TRIGGER.length) return null;
  // Searching BACKWARDS from the caret finds the nearest opener, so a second
  // reference being typed after a finished one attaches to its own `@<`.
  const start = value.lastIndexOf(
    PICKER_TRIGGER,
    caret - PICKER_TRIGGER.length,
  );
  if (start < 0) return null;
  const query = value.slice(start + PICKER_TRIGGER.length, caret);
  if (NOT_IN_PATH.test(query)) return null;
  return { start, end: caret, query };
}

/** Whether a recorded trigger still describes an unfinished `@<…` in `value`. */
function stillOpenIn(
  value: string,
  trigger: TriggerRange | null,
): trigger is TriggerRange {
  if (trigger === null || trigger.end > value.length) return false;
  const opener = value.slice(
    trigger.start,
    trigger.start + PICKER_TRIGGER.length,
  );
  if (opener !== PICKER_TRIGGER) return false;
  const query = value.slice(trigger.start + PICKER_TRIGGER.length, trigger.end);
  return !NOT_IN_PATH.test(query);
}

/**
 * Writes a picked token into a value, and says where the caret lands.
 *
 * A pick lands in one of two places: over the whole `@<…` being typed, or at the
 * caret when the picker was opened from its button. The trigger is re-checked
 * against the CURRENT value rather than trusted — it was recorded on an earlier
 * keystroke, and a range that no longer holds what it claims would eat the
 * user's text. Re-deriving it from the recorded `start` (rather than comparing
 * the whole slice) is what lets the range legitimately cover a query that has
 * grown since.
 */
export function applyPickedToken(
  value: string,
  token: string,
  selection: { start: number; end: number },
  trigger: TriggerRange | null,
): { value: string; caret: number } {
  const range = stillOpenIn(value, trigger) ? trigger : selection;
  return {
    value: value.slice(0, range.start) + token + value.slice(range.end),
    caret: range.start + token.length,
  };
}

export type FieldSegment = { text: string; isToken: boolean };

/** True when the text holds at least one complete `@<path>@` token. */
export function hasPlaceholder(value: string): boolean {
  // `match` (unlike `test`) is stateless on a global regex — see template-token.
  return value.match(PLACEHOLDER_RE) !== null;
}

/**
 * Splits text into its literal runs and its `@<path>@` tokens, in order, so a
 * field can paint the tokens differently from the prose around them.
 * Concatenating the segments always reproduces the input exactly — the highlight
 * layer has to stay glyph-for-glyph aligned with the real input under it.
 */
export function splitPlaceholders(value: string): FieldSegment[] {
  const segments: FieldSegment[] = [];
  let last = 0;
  // `matchAll` clones the regex, so the shared global PLACEHOLDER_RE keeps its
  // `lastIndex` untouched for every other caller.
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    const start = match.index ?? 0;
    if (start > last) {
      segments.push({ text: value.slice(last, start), isToken: false });
    }
    segments.push({ text: match[0], isToken: true });
    last = start + match[0].length;
  }
  if (last < value.length) {
    segments.push({ text: value.slice(last), isToken: false });
  }
  return segments;
}
