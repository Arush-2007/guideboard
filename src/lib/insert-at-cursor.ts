/**
 * Where an insert should land in a control: its selection, or the end of the
 * value when the control isn't the one being typed in.
 *
 * The focus check is the whole point. A control the user has never clicked into
 * reports `selectionStart` of 0 — not `null` — so trusting it blindly puts every
 * inserted token at the START of an existing value: opening a saved node whose
 * message reads `Order shipped` and picking a field gives
 * `@<AI_TEXT_1.output>@Order shipped`. That is invisible on a new node, where 0
 * IS the end. Unless the control actually holds focus, an insert belongs at the
 * end.
 */
export function caretRangeIn(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  currentValue: string,
): { start: number; end: number } {
  const focused =
    element !== null &&
    typeof document !== "undefined" &&
    document.activeElement === element;
  if (
    !focused ||
    element.selectionStart == null ||
    element.selectionEnd == null
  ) {
    return { start: currentValue.length, end: currentValue.length };
  }
  return { start: element.selectionStart, end: element.selectionEnd };
}

export function focusAfterInsert(
  element: HTMLInputElement | HTMLTextAreaElement,
  caretAfterInsert: number,
) {
  requestAnimationFrame(() => {
    element.setSelectionRange(caretAfterInsert, caretAfterInsert);
    element.focus();
  });
}
