"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { useDanglingRefGuard } from "@/components/dangling-ref-guard";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "@/components/variable-input";
import { VariableTextarea } from "@/components/variable-textarea";
import {
  asFormat,
  describeSelection,
  FORMAT_META,
  type Format,
  inputKindForSelection,
  inputPlaceholderFor,
  sourcesForTarget,
  TARGET_FORMATS,
} from "@/lib/conversions";

const AUTO = "auto";

const formSchema = z.object({
  to: z.enum(TARGET_FORMATS as [string, ...string[]]),
  // "auto" (or omitted) means auto-detect the source at runtime.
  from: z.string().optional(),
  input: z.string().min(1, "An input value is required"),
});

export type ConvertFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ConvertFormValues) => void;
  defaultValues?: Partial<ConvertFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

const DEFAULT_TARGET = TARGET_FORMATS[0];

export const ConvertDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<ConvertFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      to: defaultValues.to ?? DEFAULT_TARGET,
      from: defaultValues.from ?? AUTO,
      input: defaultValues.input ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        to: defaultValues.to ?? DEFAULT_TARGET,
        from: defaultValues.from ?? AUTO,
        input: defaultValues.input ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const to = form.watch("to") as Format;
  const fromValue = form.watch("from") ?? AUTO;
  const from = fromValue === AUTO ? undefined : asFormat(fromValue);

  const sourceOptions = sourcesForTarget(to);

  // If the pinned source can't produce the newly-selected target, fall back to
  // auto-detect so the form never holds an impossible (from, to) pair.
  useEffect(() => {
    if (from && !sourceOptions.includes(from)) {
      form.setValue("from", AUTO);
    }
  }, [from, sourceOptions, form]);

  const inputKind = inputKindForSelection(to, from);
  const placeholder = inputPlaceholderFor(to, from);

  const handleSubmit = (values: ConvertFormValues) => {
    onSubmit({
      ...values,
      // Don't persist the "auto" sentinel — an absent `from` means auto-detect.
      from: values.from === AUTO ? undefined : values.from,
    });
    onOpenChange(false);
  };

  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Convert data to a fixed target format. The input format is
            auto-detected unless you pin it. The result is available downstream
            as <span className="font-mono">result</span>.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(guard.save)}
            className="mt-4 space-y-6"
          >
            <div className="flex items-start gap-4">
              <FormField
                control={form.control}
                name="from"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Source format</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value ?? AUTO}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={AUTO}>Auto-detect</SelectItem>
                        {sourceOptions.map((f) => (
                          <SelectItem key={f} value={f}>
                            {FORMAT_META[f].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="to"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Convert to</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TARGET_FORMATS.map((f) => (
                          <SelectItem key={f} value={f}>
                            {FORMAT_META[f].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <p className="text-muted-foreground text-sm">
              {describeSelection(to, from)}
            </p>

            <FormField
              control={form.control}
              name="input"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {inputKind === "url" ? "Source URL" : "Input"}
                  </FormLabel>
                  <FormControl>
                    {inputKind === "url" ? (
                      <VariableInput
                        placeholder={placeholder}
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        {...field}
                      />
                    ) : (
                      <VariableTextarea
                        rows={6}
                        placeholder={placeholder}
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        {...field}
                      />
                    )}
                  </FormControl>
                  <FormDescription>
                    Insert an upstream value with the{" "}
                    <span className="font-mono">{"{ }"}</span> button.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="mt-4">
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
        {guard.dialog}
      </DialogContent>
    </Dialog>
  );
};
