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
export function usePickerTrigger() {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const triggerRef = React.useRef<TriggerRange | null>(null);

  /** Call after every user edit, with the control that was edited. */
  const noteEdit = (el: FieldElement, enabled = true) => {
    const range = enabled
      ? triggerRangeBefore(el.value, el.selectionStart)
      : null;
    triggerRef.current = range;
    // Typing on past the trigger dismisses the picker again, so the shortcut
    // never lingers over text the user has moved beyond.
    setPickerOpen(range !== null);
  };

  /** The trigger a pick should consume, cleared as it is taken. */
  const takeTrigger = (): TriggerRange | null => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    return trigger;
  };

  /** Closing the picker any other way abandons the trigger it was opened on. */
  const handlePickerOpenChange = (open: boolean) => {
    if (!open) triggerRef.current = null;
    setPickerOpen(open);
  };

  return { pickerOpen, noteEdit, takeTrigger, handlePickerOpenChange };
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
  name,
  forwardedRef,
  disabled,
}: {
  value: unknown;
  onChange?: React.ChangeEventHandler<T>;
  name?: string;
  forwardedRef: React.ForwardedRef<T>;
  disabled?: boolean;
}) {
  const innerRef = React.useRef<T | null>(null);
  const trigger = usePickerTrigger();

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
    strValue,
    /** Whether to swap in the highlight layer at all. */
    highlighted: hasPlaceholder(strValue),
    pickerOpen: trigger.pickerOpen,
    handlePickerOpenChange: trigger.handlePickerOpenChange,
    handleChange,
    insert,
    replaceAll,
  };
}
