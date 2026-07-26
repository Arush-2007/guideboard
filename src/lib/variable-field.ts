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

export type TriggerRange = { start: number; end: number };

/**
 * The range of a `@<` sitting immediately before the caret, or null.
 *
 * Deliberately anchored to the caret rather than searching the whole value: an
 * already-written `@<AI_TEXT_1.output>@` further along the line is a finished
 * token, not an invitation to open the picker.
 */
export function triggerRangeBefore(
  value: string,
  caret: number | null | undefined,
): TriggerRange | null {
  if (caret == null || caret < PICKER_TRIGGER.length) return null;
  const start = caret - PICKER_TRIGGER.length;
  return value.slice(start, caret) === PICKER_TRIGGER
    ? { start, end: caret }
    : null;
}

/**
 * Writes a picked token into a value, and says where the caret lands.
 *
 * A pick lands in one of two places: over the `@<` that summoned the picker, or
 * at the caret when the picker was opened from its button. The trigger is
 * re-checked rather than trusted — the value can have moved on since it was
 * recorded, and replacing the wrong two characters would eat the user's text.
 */
export function applyPickedToken(
  value: string,
  token: string,
  selection: { start: number; end: number },
  trigger: TriggerRange | null,
): { value: string; caret: number } {
  const range =
    trigger && value.slice(trigger.start, trigger.end) === PICKER_TRIGGER
      ? trigger
      : selection;
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
