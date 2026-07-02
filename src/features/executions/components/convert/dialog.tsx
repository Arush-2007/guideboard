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
import { VariableInput } from "@/components/variable-input";
import { VariableTextarea } from "@/components/variable-textarea";
import {
  CONVERSION_KINDS,
  CONVERSION_OPTIONS,
  conversionOption,
} from "@/lib/conversions";

const formSchema = z.object({
  conversion: z.enum(CONVERSION_KINDS as [string, ...string[]]),
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
      conversion: defaultValues.conversion ?? "pdf_to_text",
      input: defaultValues.input ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        conversion: defaultValues.conversion ?? "pdf_to_text",
        input: defaultValues.input ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const conversion = form.watch(
    "conversion",
  ) as ConvertFormValues["conversion"];
  const option = conversionOption(conversion);

  const handleSubmit = (values: ConvertFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convert</DialogTitle>
          <DialogDescription>
            Convert data from one format to another. The result is available
            downstream as <span className="font-mono">result</span>.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="conversion"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Conversion</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CONVERSION_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{option.description}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="input"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {option.inputKind === "url" ? "Source URL" : "Input"}
                  </FormLabel>
                  <FormControl>
                    {option.inputKind === "url" ? (
                      <VariableInput
                        placeholder={option.placeholder}
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        {...field}
                      />
                    ) : (
                      <VariableTextarea
                        rows={6}
                        placeholder={option.placeholder}
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
      </DialogContent>
    </Dialog>
  );
};
