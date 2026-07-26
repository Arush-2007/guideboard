"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createId } from "@paralleldrive/cuid2";
import { Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import z from "zod";
import { EditableNodeTitle } from "@/components/editable-node-title";
import {
  MatchingOptions,
  makeMatchingOptionsHandler,
} from "@/components/matching-options";
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
import { compareOptionsSchemaFields } from "@/lib/compare-options-schema";

const operatorEnum = z.enum([
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
]);

const caseSchema = z.object({
  id: z.string(),
  field: z.string().min(1, { message: "Field is required" }),
  operator: operatorEnum,
  value: z.string(),
  ...compareOptionsSchemaFields,
});

const formSchema = z.object({
  cases: z.array(caseSchema).min(1, { message: "Add at least one case" }),
});

export type SwitchFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: SwitchFormValues) => void;
  defaultValues?: Partial<SwitchFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

const newCase = (): SwitchFormValues["cases"][number] => ({
  id: createId(),
  field: "",
  operator: "equals",
  value: "",
});

// Module-scoped (stable) so it isn't a hook dependency: normalize stored cases
// into form values, falling back to a single empty case for a fresh node.
const toFormValues = (
  defaults: Partial<SwitchFormValues>,
): SwitchFormValues => ({
  cases:
    defaults.cases && defaults.cases.length > 0
      ? defaults.cases.map((c) => ({
          id: c.id ?? createId(),
          field: c.field ?? "",
          operator: c.operator ?? "equals",
          value: c.value ?? "",
          ignoreCase: c.ignoreCase ?? false,
          ignoreChars: c.ignoreChars ?? "",
          numeric: c.numeric ?? false,
        }))
      : [newCase()],
});

export const SwitchDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<SwitchFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(defaultValues),
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "cases",
  });

  useEffect(() => {
    if (open) {
      form.reset(toFormValues(defaultValues));
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: SwitchFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh]">
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Route the workflow to a different branch depending on which case
            matches first. Anything that matches no case takes the Default
            output.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            {fields.map((fieldItem, index) => {
              const operator = form.watch(`cases.${index}.operator`);
              const showValue = !["is_empty", "is_not_empty"].includes(
                operator,
              );
              return (
                <div
                  key={fieldItem.id}
                  className="space-y-4 rounded-lg border p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      Case {index + 1}
                    </span>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(index)}
                        aria-label={`Remove case ${index + 1}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>

                  <FormField
                    control={form.control}
                    name={`cases.${index}.field`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Field</FormLabel>
                        <FormControl>
                          <VariableInput
                            placeholder="A fixed value, or @<ai_text_abc.output>@"
                            currentNodeId={currentNodeId}
                            workflowId={workflowId}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name={`cases.${index}.operator`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Operator</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select operator" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="contains">Contains</SelectItem>
                            <SelectItem value="not_contains">
                              Does not contain
                            </SelectItem>
                            <SelectItem value="equals">Equals</SelectItem>
                            <SelectItem value="not_equals">
                              Does not equal
                            </SelectItem>
                            <SelectItem value="greater_than">
                              Greater than
                            </SelectItem>
                            <SelectItem value="less_than">Less than</SelectItem>
                            <SelectItem value="is_empty">Is empty</SelectItem>
                            <SelectItem value="is_not_empty">
                              Is not empty
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {showValue && (
                    <FormField
                      control={form.control}
                      name={`cases.${index}.value`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Value</FormLabel>
                          <FormControl>
                            <VariableInput
                              placeholder="A fixed value, or @<node.output>@"
                              currentNodeId={currentNodeId}
                              workflowId={workflowId}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  <MatchingOptions
                    operator={operator}
                    ignoreCase={form.watch(`cases.${index}.ignoreCase`)}
                    ignoreChars={form.watch(`cases.${index}.ignoreChars`)}
                    numeric={form.watch(`cases.${index}.numeric`)}
                    onChange={makeMatchingOptionsHandler(
                      form,
                      `cases.${index}.`,
                    )}
                    idPrefix={`switch-${fieldItem.id}`}
                  />
                </div>
              );
            })}

            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => append(newCase())}
            >
              <Plus className="mr-2 size-4" />
              Add case
            </Button>

            <DialogFooter className="mt-4">
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
