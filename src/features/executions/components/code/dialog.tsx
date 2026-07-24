"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { VariablePicker } from "@/components/variable-picker";
import { focusAfterInsert, insertAtCursor } from "@/lib/insert-at-cursor";
import { cn } from "@/lib/utils";

// Mirrors `codeSchema` in node-schemas.ts. Both are required: the dialog strips
// any key its own schema doesn't declare, so a field that exists only in
// node-schemas.ts would never survive a save.
const formSchema = z.object({
  code: z.string().min(1, "Write some code to run"),
});

export type CodeFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CodeFormValues) => void;
  defaultValues?: Partial<CodeFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

/**
 * Seed shown in an empty editor. A worked example teaches the two rules that
 * aren't obvious — read from `input`, and `return` the result — far better than
 * prose does.
 */
const EXAMPLE_CODE = `// 'input' holds the output of every earlier step.
// Return the value this step should pass on.
return {
  greeting: "Hello, " + input.name,
};`;

export const CodeDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<CodeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { code: defaultValues.code ?? "" },
  });

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      form.reset({ code: defaultValues.code ?? "" });
    }
  }, [open, defaultValues, form]);

  const code = form.watch("code") ?? "";

  const setCode = (next: string, caret?: number) => {
    form.setValue("code", next, { shouldValidate: true, shouldDirty: true });
    const el = textareaRef.current;
    if (el && caret !== undefined) focusAfterInsert(el, caret);
  };

  /**
   * Inserts a variable at the caret as a JavaScript accessor (`input.<path>`),
   * not the `@<path>@` template token: this field is real code, so the token
   * would be a syntax error. The picker's `bare` mode hands us the dotted
   * context path (e.g. `AI_TEXT_1.output`), which is exactly what lives on
   * `input`, so prefixing `input.` yields a valid expression.
   */
  const insertVariable = (barePath: string) => {
    const el = textareaRef.current;
    // Reads the live caret from the element (an unfocused textarea reports 0,
    // which would prepend); fall back to appending at the end in that case.
    const focused =
      el !== null &&
      typeof document !== "undefined" &&
      document.activeElement === el;
    const caret =
      focused && el.selectionStart !== null ? el.selectionStart : code.length;

    const snippet = `input.${barePath}`;
    const next = insertAtCursor(focused ? el : null, code, snippet);
    setCode(next, caret + snippet.length);
  };

  const handleSubmit = (values: CodeFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Run JavaScript on data from earlier steps. Read from{" "}
            <span className="font-mono">input</span> and{" "}
            <span className="font-mono">return</span> a value — it's available
            downstream as <span className="font-mono">result</span>.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 min-w-0 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-sm">
                Insert a value from an earlier step:
              </span>
              {/* `bare` so the picker yields a dotted path we turn into
                  `input.<path>`, rather than a `@<path>@` template token that
                  would be invalid inside JavaScript. */}
              <VariablePicker
                currentNodeId={currentNodeId}
                workflowId={workflowId}
                currentValue={code}
                onSelect={insertVariable}
                bare
              />
            </div>

            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem className="min-w-0">
                  <FormControl>
                    <Textarea
                      {...field}
                      ref={(el) => {
                        field.ref(el);
                        textareaRef.current = el;
                      }}
                      placeholder={EXAMPLE_CODE}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      rows={12}
                      className={cn(
                        "min-h-[16rem] resize-y font-mono text-sm",
                        // Long lines scroll inside the box instead of widening
                        // the dialog.
                        "whitespace-pre overflow-auto",
                      )}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <p className="text-muted-foreground text-sm">
              Runs in a secure sandbox: no network, files, or imports, and a
              1-second time limit. Return plain data (objects, arrays, strings,
              numbers) — anything a workflow can carry.
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
