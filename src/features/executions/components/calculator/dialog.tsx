"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Delete } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { usePickerTrigger } from "@/components/use-variable-field";
import {
  HIGHLIGHTABLE_CONTROL_CLASS,
  HIGHLIGHTED_CONTROL_CLASS,
  VariableHighlight,
} from "@/components/variable-highlight";
import { VariablePicker } from "@/components/variable-picker";
import { toPlainDecimal, tryEvaluateExpression } from "@/lib/expression";
import { caretRangeIn, focusAfterInsert } from "@/lib/insert-at-cursor";
import { PLACEHOLDER_RE } from "@/lib/template-token";
import { cn } from "@/lib/utils";
import {
  applyPickedToken,
  hasPlaceholder,
  type TriggerRange,
} from "@/lib/variable-field";
import { applyBackspace, nextBracket, toReadableExpression } from "./keypad";

// Mirrors `calculatorSchema` in node-schemas.ts. Both are required: the dialog
// strips any key its own schema doesn't declare, so a field that exists only in
// node-schemas.ts would never survive a save.
const formSchema = z.object({
  expression: z.string().min(1, "Enter something to calculate"),
});

export type CalculatorFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CalculatorFormValues) => void;
  defaultValues?: Partial<CalculatorFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

/**
 * A key that types something into the expression. Operators carry their spaces
 * so `2`,`+`,`3` reads as `2 + 3` rather than `2+3` — the tokenizer ignores
 * whitespace either way, this is purely for legibility.
 */
type InsertKey = { label: string; insert: string; kind?: "operator" };

const FUNCTION_KEYS: InsertKey[] = [
  { label: "round", insert: "round(" },
  { label: "floor", insert: "floor(" },
  { label: "ceil", insert: "ceil(" },
  { label: "abs", insert: "abs(" },
  { label: ",", insert: ", " },
];

/**
 * Rows 2-5 of the pad. Row 1 (clear / brackets / % / ÷) and the bottom row are
 * built inline because their keys are actions rather than plain inserts.
 *
 * `*` and `/` are inserted as ASCII, not as `×`/`÷`: the stored expression stays
 * something a user can type, paste or hand-edit. The glyphs appear in the
 * readable line under the display, and the evaluator accepts both anyway.
 */
const NUMBER_ROWS: InsertKey[][] = [
  [
    { label: "7", insert: "7" },
    { label: "8", insert: "8" },
    { label: "9", insert: "9" },
    { label: "×", insert: " * ", kind: "operator" },
  ],
  [
    { label: "4", insert: "4" },
    { label: "5", insert: "5" },
    { label: "6", insert: "6" },
    { label: "−", insert: " - ", kind: "operator" },
  ],
  [
    { label: "1", insert: "1" },
    { label: "2", insert: "2" },
    { label: "3", insert: "3" },
    { label: "+", insert: " + ", kind: "operator" },
  ],
];

/**
 * What the strip under the display is currently saying. Only `value` has an
 * answer to show, so only `value` needs the two-column layout — the rest are a
 * single sentence, which keeps each state's rendering unambiguous.
 */
type Preview =
  | { kind: "empty"; note: string }
  | { kind: "error"; note: string }
  | { kind: "deferred"; note: string }
  | { kind: "value"; readable: string; note: string };

/**
 * The display's own look, shared with its highlight layer so the two copies of
 * the expression land on the same pixel — see `VariableHighlight`.
 *
 * No text-size override: the base Input's `text-base md:text-sm` is what every
 * other field in the app renders at, and a one-off `text-lg` here made the
 * display the only oversized control in any dialog. `font-mono` stays — an
 * expression should be monospaced — and the box keeps a little extra height so
 * it still reads as a display rather than a plain text field. `text-right`
 * keeps the tail of a long expression in view while typing.
 */
const DISPLAY_CLASS = "h-12 text-right font-mono";

export const CalculatorDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<CalculatorFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { expression: defaultValues.expression ?? "" },
  });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const trigger = usePickerTrigger();

  useEffect(() => {
    if (open) {
      form.reset({ expression: defaultValues.expression ?? "" });
    }
  }, [open, defaultValues, form]);

  const expression = form.watch("expression") ?? "";
  /** Only an expression holding references needs the highlight layer at all. */
  const highlighted = hasPlaceholder(expression);

  const setExpression = (next: string, caret?: number) => {
    form.setValue("expression", next, {
      shouldValidate: true,
      shouldDirty: true,
    });
    const el = inputRef.current;
    if (el && caret !== undefined) focusAfterInsert(el, caret);
  };

  /**
   * Where a keypad press should act. The unfocused-display rule this depends on
   * — a keypress on a node you haven't clicked into appends rather than
   * prepending — lives in `caretRangeIn`, shared with the variable fields.
   */
  const caretRange = () => caretRangeIn(inputRef.current, expression);

  /**
   * Types `text` at the caret, exactly as `VariableInput` does for its picker.
   * A pick carries the `@<` that summoned the picker, if that is how it was
   * opened, so the two characters are consumed rather than left behind.
   */
  const insert = (text: string, pickTrigger: TriggerRange | null = null) => {
    // An unfocused display reports the end of the expression, so this appends —
    // which is what a keypad press on an untouched node should do.
    const { start, end } = caretRange();
    const result = applyPickedToken(
      expression,
      text,
      { start, end },
      pickTrigger,
    );
    setExpression(result.value, result.caret);
  };

  const backspace = () => {
    const { start, end } = caretRange();
    const result = applyBackspace(expression, start, end);
    // Backspacing at the very start changes nothing; writing anyway would mark
    // the form dirty and re-run validation for a keypress that did nothing.
    if (result.value === expression) return;
    setExpression(result.value, result.caret);
  };

  /** One bracket key: closes an open bracket, otherwise opens a new one. */
  const insertBracket = () => {
    insert(nextBracket(expression, caretRange().start));
  };

  const preview = useMemo((): Preview => {
    const trimmed = expression.trim();
    if (trimmed === "") {
      return { kind: "empty", note: "Nothing to calculate yet." };
    }

    // `.match` is stateless; PLACEHOLDER_RE is a global regex, so `.test`/`.exec`
    // would carry `lastIndex` between renders (see template-token.ts).
    const hasReferences = expression.match(PLACEHOLDER_RE) !== null;

    // Syntax is checkable even with references present: swap each one for a
    // harmless `1` and parse that. Structural mistakes (a stray bracket, a
    // dangling operator) surface while editing rather than at run time. `1`
    // specifically avoids inventing a divide-by-zero the real values may not have.
    //
    // With no references the probe IS the expression, so this single evaluation
    // yields the real answer too — no second pass needed.
    const attempt = tryEvaluateExpression(
      expression.replace(PLACEHOLDER_RE, "1"),
    );

    // `!== null` rather than a truthiness check: it discriminates the union so
    // TypeScript knows `attempt.value` is a number below.
    if (attempt.error !== null) {
      return { kind: "error", note: attempt.error };
    }

    // No echo of the expression here. There is no answer to sit beside it, and
    // repeating what the user is already looking at — truncated, at that — says
    // less than the sentence explaining WHY there's no answer yet.
    if (hasReferences) {
      return {
        kind: "deferred",
        note: "Uses values from earlier steps — calculated when the workflow runs.",
      };
    }

    return {
      kind: "value",
      // Show `SHEETS_1.price × 1.18` instead of `@<SHEETS_1.price>@ * 1.18`.
      readable: toReadableExpression(expression),
      // Plain decimal, so a small answer reads as `0.0000001` and not `1e-7`.
      note: `= ${toPlainDecimal(attempt.value)}`,
    };
  }, [expression]);

  const handleSubmit = (values: CalculatorFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  // `min-w-0 px-1` for the same reason as the function row: a `whitespace-nowrap`
  // Button at default `px-4` cannot shrink inside its grid cell.
  const keyClass = "h-12 min-w-0 px-1 text-base font-medium";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Work out a number from earlier steps. The answer is available
            downstream as <span className="font-mono">result</span>.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            /* `min-w-0` is load-bearing. DialogContent's scroll wrapper is a
               `grid`, whose auto column takes its minimum from this item's
               min-content width. Left at the default `min-width: auto`, this
               form refuses to shrink, widens the track past the dialog's
               max-width, and — because `overflow-y: auto` forces `overflow-x`
               to `auto` — produces a horizontal scrollbar across the whole
               dialog with the keypad's last column cut off. */
            className="mt-4 min-w-0 space-y-4"
          >
            <FormField
              control={form.control}
              name="expression"
              render={({ field }) => (
                <FormItem className="min-w-0">
                  {/* One cell holding the input and the layer that paints its
                      references blue — see VariableHighlight. */}
                  <div className="grid grid-cols-1">
                    <FormControl>
                      {/* A real input, not rendered chips: the caret, keyboard
                          entry, selection and paste all have to work, and every
                          key inserts at the caret position.
                          This is the ONLY element allowed to scroll sideways: an
                          <input> already scrolls its own text natively, and the
                          base Input carries `w-full min-w-0`, so a long
                          expression stays inside the box instead of widening the
                          dialog. */}
                      <Input
                        {...field}
                        ref={(el) => {
                          field.ref(el);
                          inputRef.current = el;
                        }}
                        onChange={(event) => {
                          field.onChange(event);
                          trigger.noteEdit(event.currentTarget);
                        }}
                        placeholder="e.g. 1200 * 1.18"
                        autoComplete="off"
                        spellCheck={false}
                        className={cn(
                          "col-start-1 row-start-1",
                          HIGHLIGHTABLE_CONTROL_CLASS,
                          DISPLAY_CLASS,
                          highlighted && HIGHLIGHTED_CONTROL_CLASS,
                        )}
                      />
                    </FormControl>
                    {highlighted ? (
                      <VariableHighlight
                        value={expression}
                        controlRef={inputRef}
                        className={DISPLAY_CLASS}
                      />
                    ) : null}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Readable echo of the expression + the live answer.
                Nothing in here may widen the dialog: the expression display is
                the only thing that scrolls, and it scrolls INSIDE its own box.
                `overflow-hidden` is the backstop, but each child is also
                individually constrained — see below. */}
            <div className="min-h-10 overflow-hidden rounded-md bg-muted/50 px-3 py-2">
              {preview.kind === "value" ? (
                <div className="flex items-baseline justify-between gap-4">
                  {/* `min-w-0` is what makes `truncate` work at all: a flex item
                      defaults to min-width:auto and would otherwise refuse to
                      shrink below its text, stretching the dialog instead of
                      ellipsing. */}
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-sm">
                    {preview.readable}
                  </span>
                  {/* The answer is the important half, so it is never truncated
                      — but it is capped and allowed to break, because
                      `toPlainDecimal` can legitimately return a very long
                      string (5e-324 expands to 326 characters). It wraps
                      downward rather than pushing outward. */}
                  <span className="max-w-[55%] break-all text-right font-medium text-foreground text-sm">
                    {preview.note}
                  </span>
                </div>
              ) : (
                // Every other state is one sentence across the full width, so it
                // wraps rather than competing for horizontal space.
                <p
                  className={cn(
                    "text-sm",
                    preview.kind === "error"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {preview.note}
                </p>
              )}
            </div>

            <div className="grid min-w-0 grid-cols-5 gap-2">
              {FUNCTION_KEYS.map((key) => (
                <Button
                  key={key.label}
                  type="button"
                  variant="ghost"
                  /* `min-w-0 px-1`: shadcn's Button is `whitespace-nowrap` with
                     `px-4`, so at its default padding a key cannot shrink below
                     its label and spills out of its grid cell on a narrow
                     window. These labels are short enough not to need it. */
                  className="h-9 min-w-0 px-1 font-mono text-muted-foreground text-xs"
                  onClick={() => insert(key.insert)}
                >
                  {key.label}
                </Button>
              ))}
            </div>

            <div className="grid min-w-0 grid-cols-4 gap-2">
              <Button
                type="button"
                variant="secondary"
                className={keyClass}
                onClick={() => setExpression("", 0)}
              >
                C
              </Button>
              <Button
                type="button"
                variant="secondary"
                className={keyClass}
                onClick={insertBracket}
              >
                ( )
              </Button>
              <Button
                type="button"
                variant="secondary"
                className={keyClass}
                onClick={() => insert(" % ")}
                title="Remainder after dividing"
              >
                %
              </Button>
              <Button
                type="button"
                variant="secondary"
                className={keyClass}
                onClick={() => insert(" / ")}
              >
                ÷
              </Button>

              {NUMBER_ROWS.flat().map((key) => (
                <Button
                  key={key.label}
                  type="button"
                  variant={key.kind === "operator" ? "secondary" : "outline"}
                  className={keyClass}
                  onClick={() => insert(key.insert)}
                >
                  {key.label}
                </Button>
              ))}

              <Button
                type="button"
                variant="outline"
                className={keyClass}
                onClick={() => insert("0")}
              >
                0
              </Button>
              <Button
                type="button"
                variant="outline"
                className={keyClass}
                onClick={() => insert(".")}
              >
                .
              </Button>
              {/* The picker is reused as-is; it just lives in the pad instead of
                  floating in the field's corner, so it reads as a calculator key. */}
              <VariablePicker
                currentNodeId={currentNodeId}
                workflowId={workflowId}
                currentValue={expression}
                onSelect={(token) => insert(token, trigger.takeTrigger())}
                open={trigger.pickerOpen}
                onOpenChange={trigger.handlePickerOpenChange}
                className={cn(keyClass, "size-full")}
              />
              <Button
                type="button"
                variant="secondary"
                className={keyClass}
                onClick={backspace}
                aria-label="Delete the last entry"
              >
                <Delete className="size-4" />
              </Button>
            </div>

            {/* `text-sm` to match `FormDescription`, which is what every other
                node dialog uses for helper copy like this. */}
            <p className="text-muted-foreground text-sm">
              Use the braces key to pull in a value from an earlier step.{" "}
              <span className="font-mono">%</span> gives the remainder after
              dividing — for a percentage, multiply and divide by 100.
            </p>

            <DialogFooter className="mt-4">
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
