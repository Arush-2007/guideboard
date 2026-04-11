/**
 * Inserts text at the current selection in an input/textarea, or appends if
 * there is no selection info.
 */
export function insertAtCursor(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  currentValue: string,
  insert: string,
): string {
  if (
    !element ||
    element.selectionStart == null ||
    element.selectionEnd == null
  ) {
    return currentValue + insert;
  }
  const start = element.selectionStart;
  const end = element.selectionEnd;
  return currentValue.slice(0, start) + insert + currentValue.slice(end);
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
