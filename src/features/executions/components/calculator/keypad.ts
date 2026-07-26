import { PLACEHOLDER_RE } from "@/lib/template-token";

/**
 * Pure keypad/display logic for the Calculator node, kept out of the components
 * so it can be tested directly — `dialog.tsx` owns the rendering, this owns the
 * behaviour.
 *
 * Dependency-free by the same rule as `expression.ts`: both run in the browser.
 */

/**
 * Turns a stored expression into something readable on screen:
 * `@<SHEETS_1.price>@ * 1.18` becomes `SHEETS_1.price × 1.18`.
 *
 * Shared by the dialog's preview line and the canvas node's description — they
 * showed the same thing via two copies of this transform, which is exactly the
 * kind of drift that ends with the canvas and the dialog disagreeing.
 */
export function toReadableExpression(expression: string | undefined): string {
  return (expression ?? "")
    .replace(PLACEHOLDER_RE, (_token, path: string) => path)
    .replace(/\*/g, "×")
    .replace(/\//g, "÷");
}

/** Matches a complete `@<...>@` reference sitting immediately before the caret. */
const TOKEN_BEFORE_CARET = /@<[^>]*>@$/;

export type BackspaceResult = {
  value: string;
  /** Where the caret belongs afterwards. */
  caret: number;
};

/**
 * Deletes the selection, or — with no selection — the single entry before the
 * caret.
 *
 * A whole `@<path>@` reference counts as ONE entry. Removing it a character at
 * a time would leave a mangled token that silently stops resolving and reads as
 * plain text at run time, which is worse than not deleting at all.
 */
export function applyBackspace(
  expression: string,
  selectionStart: number,
  selectionEnd: number,
): BackspaceResult {
  // Guard against carets outside the string (stale refs, programmatic calls).
  const end = Math.max(0, Math.min(selectionEnd, expression.length));
  const start = Math.max(0, Math.min(selectionStart, end));

  if (start !== end) {
    return {
      value: expression.slice(0, start) + expression.slice(end),
      caret: start,
    };
  }

  if (start === 0) return { value: expression, caret: 0 };

  const token = expression.slice(0, start).match(TOKEN_BEFORE_CARET);
  const from = token ? start - token[0].length : start - 1;
  return {
    value: expression.slice(0, from) + expression.slice(end),
    caret: from,
  };
}

/**
 * Which bracket the single `( )` key should type: a closing one when there is
 * an unclosed bracket to close, an opening one otherwise — the behaviour of the
 * one-bracket-key calculators this pad is modelled on.
 *
 * Only brackets BEFORE the caret count. Judging by the whole string would type
 * `)` while the caret sits at the very start, in front of every bracket it was
 * counting.
 */
export function nextBracket(expression: string, caret: number): "(" | ")" {
  const before = expression.slice(
    0,
    Math.max(0, Math.min(caret, expression.length)),
  );
  const opened = (before.match(/\(/g) ?? []).length;
  const closed = (before.match(/\)/g) ?? []).length;
  return opened > closed ? ")" : "(";
}
