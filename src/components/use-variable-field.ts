"use client";

import * as React from "react";
import { caretRangeIn, focusAfterInsert } from "@/lib/insert-at-cursor";
import {
  applyPickedToken,
  hasPlaceholder,
  type TriggerRange,
  triggerRangeBefore,
} from "@/lib/variable-field";

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * The typed-`@<` shortcut, on its own: watch a control's edits, open the picker
 * when the user types the trigger, and hand that trigger to whatever they pick
 * so it is consumed rather than left behind (`@<@<AI_TEXT_1.output>@`).
 *
 * Separate from `useVariableField` because the Calculator's display owns its own
 * caret rules (its keypad inserts into an unfocused input) and can't use the
 * full wrapper — but the shortcut must behave identically there.
 */
export function usePickerTrigger({
  /**
   * Whether typing on PAST the trigger dismisses the picker again.
   *
   * True where the shortcut is the only thing that opens the panel (the
   * Calculator's keypad key): the panel it summoned should not linger over text
   * the user has moved beyond. False in a variable field, where FOCUS owns the
   * panel — there the shortcut may only nudge it open, and closing on the next
   * keystroke would fight the whole point of a panel that stays up while you
   * write. The trigger range is recorded either way, because consuming the `@<`
   * on insert is the shortcut's other, load-bearing job.
   */
  closeOnTypePast = true,
}: {
  closeOnTypePast?: boolean;
} = {}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // STATE, not a ref: the query inside it narrows what the panel shows, so the
  // panel has to re-render as it is typed. The range half is still only read at
  // insert time.
  const [trigger, setTrigger] = React.useState<TriggerRange | null>(null);

  /**
   * Call after every user edit AND every caret move, with the control involved.
   * Caret moves matter as much as edits: clicking into the middle of a
   * half-typed `@<og_sheets` shortens the query, and the panel must widen back
   * out to match.
   */
  const noteEdit = (el: FieldElement, enabled = true) => {
    const range = enabled
      ? triggerRangeBefore(el.value, el.selectionStart)
      : null;
    setTrigger(range);
    if (range !== null) setPickerOpen(true);
    else if (closeOnTypePast) setPickerOpen(false);
  };

  /** Opens the panel outright — what focusing a variable field does. */
  const openPicker = () => setPickerOpen(true);

  /** The trigger a pick should consume, cleared as it is taken. */
  const takeTrigger = (): TriggerRange | null => {
    setTrigger(null);
    return trigger;
  };

  /** Closing the picker any other way abandons the trigger it was opened on. */
  const handlePickerOpenChange = (open: boolean) => {
    if (!open) setTrigger(null);
    setPickerOpen(open);
  };

  return {
    pickerOpen,
    openPicker,
    noteEdit,
    takeTrigger,
    handlePickerOpenChange,
    /**
     * What has been typed since `@<`, or null when the caret is not inside an
     * unfinished reference. Null and "" mean different things to the panel:
     * "" is `@<` just typed (narrow by nothing, but the keyboard is now the
     * picker's), null is ordinary prose (the panel shows everything and the
     * arrow keys belong to the caret).
     */
    query: trigger?.query ?? null,
  };
}

/**
 * Everything `VariableInput` and `VariableTextarea` share: ref plumbing, the
 * typed-`@<` shortcut, insertion at the caret, and the scroll offset the
 * highlight layer needs. The two wrappers differ only in which control they
 * render, so the behaviour lives here once.
 */
export function useVariableField<T extends FieldElement>({
  value,
  onChange,
  onFocus,
  name,
  forwardedRef,
  disabled,
}: {
  value: unknown;
  onChange?: React.ChangeEventHandler<T>;
  onFocus?: React.FocusEventHandler<T>;
  name?: string;
  forwardedRef: React.ForwardedRef<T>;
  disabled?: boolean;
}) {
  const innerRef = React.useRef<T | null>(null);
  // The field's own wrapper. The picker needs it for two things: to find the
  // dialog it should open beside (there is no trigger button to ask), and to
  // know which clicks are "still in my field" and must not dismiss it.
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // FOCUS owns the panel here, so the typed shortcut must not close it — see
  // `closeOnTypePast`.
  const trigger = usePickerTrigger({ closeOnTypePast: false });

  const strValue = value === undefined || value === null ? "" : String(value);

  const setRefs = (node: T | null) => {
    innerRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };

  /** Reports a programmatic edit through the caller's `onChange`. */
  const emit = (next: string) => {
    onChange?.({
      target: { value: next, name },
    } as React.ChangeEvent<T>);
  };

  const handleChange: React.ChangeEventHandler<T> = (event) => {
    const el = event.currentTarget;
    onChange?.(event);
    trigger.noteEdit(el, !disabled);
  };

  /**
   * Caret moves, from a click or an arrow key. `select` is the one event that
   * covers both, and re-reading the trigger here is what keeps the query honest
   * when the user moves back INTO a half-typed reference rather than typing it
   * straight through.
   */
  const handleSelect: React.ReactEventHandler<T> = (event) => {
    trigger.noteEdit(event.currentTarget as T, !disabled);
  };

  /**
   * Entering the field raises the picker beside it — the field IS the way in, so
   * there is nothing to click first and nothing to learn. Closing is left to the
   * picker's own dismissal (anything outside this field), rather than to blur:
   * clicking a row in the panel blurs the input before the click lands, so
   * closing on blur would dismiss the panel out from under the pick.
   */
  const handleFocus: React.FocusEventHandler<T> = (event) => {
    onFocus?.(event);
    if (!disabled) trigger.openPicker();
  };

  const insert = (text: string) => {
    const el = innerRef.current;
    const result = applyPickedToken(
      strValue,
      text,
      // Not `el.selectionStart` directly: an unfocused control reports 0, which
      // would prepend rather than append. See `caretRangeIn`.
      caretRangeIn(el, strValue),
      trigger.takeTrigger(),
    );
    emit(result.value);
    // Controls that don't support selection (a number input) report a null
    // `selectionStart`, and `setSelectionRange` throws on them.
    if (el && el.selectionStart != null) focusAfterInsert(el, result.caret);
  };

  /** For tokens that must be a field's sole value (custom features). */
  const replaceAll = (text: string) => {
    trigger.takeTrigger();
    emit(text);
  };

  return {
    setRefs,
    /** The control itself, for the highlight layer to measure and follow. */
    innerRef,
    /** The field's wrapper — hand this to the picker as `attachedTo`. */
    containerRef,
    strValue,
    /** Whether to swap in the highlight layer at all. */
    highlighted: hasPlaceholder(strValue),
    pickerOpen: trigger.pickerOpen,
    handlePickerOpenChange: trigger.handlePickerOpenChange,
    /** The live `@<…` query the panel narrows itself by — see `usePickerTrigger`. */
    query: trigger.query,
    handleChange,
    handleFocus,
    handleSelect,
    insert,
    replaceAll,
  };
}
