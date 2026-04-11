"use client";

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
import { VariableInput } from "@/components/variable-input";
import { VariableTextarea } from "@/components/variable-textarea";
import z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

const formSchema = z.object({
  recipientPhone: z.string().min(1, "Recipient phone number is required"),
  message: z
    .string()
    .min(1, "Message is required")
    .max(4096, "WhatsApp messages cannot exceed 4096 characters"),
});

export type WhatsappActionFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: z.infer<typeof formSchema>) => void;
  defaultValues?: Partial<WhatsappActionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const WhatsappActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      recipientPhone: defaultValues.recipientPhone || "",
      message: defaultValues.message || "",
    },
  });

  // Reset form values when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        recipientPhone: defaultValues.recipientPhone || "",
        message: defaultValues.message || "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: z.infer<typeof formSchema>) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>WhatsApp Configuration</DialogTitle>
          <DialogDescription>
            Configure the WhatsApp message details for this node.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-8 mt-4"
          >
            <FormField
              control={form.control}
              name="recipientPhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Recipient Phone Number</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="e.g. 911234567890"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Use {"{{variables}}"} to pull from a previous node, e.g.{" "}
                    {"{{googleForm.responses['Phone']}}"} — or enter a fixed
                    number with country code, no plus sign.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="message"
              render={({ field }) => (
              <FormItem>
                <FormLabel>Message</FormLabel>
                <FormControl>
                  <VariableTextarea
                    placeholder="Hello {{openai_abc123.text}}"
                    className="min-h-[80px] font-mono text-sm"
                    currentNodeId={currentNodeId}
                    workflowId={workflowId}
                    {...field}
                  />
                </FormControl>
                  <FormDescription>
                    Supports {"{{variables}}"} from previous nodes.
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
