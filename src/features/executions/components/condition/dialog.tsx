"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Switch } from "@/components/ui/switch";
import { VariableInput } from "@/components/variable-input";

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

const formSchema = z.object({
  field: z.string().min(1, { message: "Field path is required" }),
  operator: operatorEnum,
  value: z.string(),
  stopOnFail: z.boolean(),
});

export type ConditionFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ConditionFormValues) => void;
  defaultValues?: Partial<ConditionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const ConditionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<ConditionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      field: defaultValues.field ?? "",
      operator: defaultValues.operator ?? "equals",
      value: defaultValues.value ?? "",
      stopOnFail: defaultValues.stopOnFail ?? true,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        field: defaultValues.field ?? "",
        operator: defaultValues.operator ?? "equals",
        value: defaultValues.value ?? "",
        stopOnFail: defaultValues.stopOnFail ?? true,
      });
    }
  }, [open, defaultValues, form]);

  const watchOperator = form.watch("operator");
  const showValueField = !["is_empty", "is_not_empty"].includes(watchOperator);

  const handleSubmit = (values: ConditionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Condition</DialogTitle>
          <DialogDescription>
            Filter the workflow by comparing a value from context using dot
            notation (e.g. commentText or myVar.nested).
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-8"
          >
            <FormField
              control={form.control}
              name="field"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Field path</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="e.g. ai_text_abc.output"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      bare
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The field to test. Pick one with the{" "}
                    <span className="font-mono">{"{ }"}</span> button — it
                    inserts a bare dot path (no{" "}
                    <span className="font-mono">{"!#…#!"}</span>).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="operator"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Operator</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
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
                      <SelectItem value="not_equals">Does not equal</SelectItem>
                      <SelectItem value="greater_than">Greater than</SelectItem>
                      <SelectItem value="less_than">Less than</SelectItem>
                      <SelectItem value="is_empty">Is empty</SelectItem>
                      <SelectItem value="is_not_empty">Is not empty</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {showValueField && (
              <FormField
                control={form.control}
                name="value"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Value</FormLabel>
                    <FormControl>
                      <VariableInput
                        placeholder="Compare to…"
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Compared as string unless both sides are valid numbers for
                      greater/less than.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="stopOnFail"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Stop on fail</FormLabel>
                    <FormDescription>
                      When false, the workflow continues even if the condition
                      is not met.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter className="mt-4">
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
