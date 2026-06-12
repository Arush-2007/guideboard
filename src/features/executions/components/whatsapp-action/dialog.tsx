"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { RecipientList } from "@/components/recipient-list";
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
import { VariableTextarea } from "@/components/variable-textarea";

const formSchema = z.object({
  recipientPhones: z
    .array(z.string())
    .transform((arr) => arr.map((s) => s.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "Add at least one recipient"),
  message: z
    .string()
    .min(1, "Message is required")
    .max(4096, "WhatsApp messages cannot exceed 4096 characters"),
});

export type WhatsappActionFormValues = z.infer<typeof formSchema>;

/** Accepts the new array shape or a legacy single `recipientPhone` string. */
function toPhoneRows(
  recipientPhones: string[] | undefined,
  legacy: string | undefined,
): string[] {
  if (Array.isArray(recipientPhones) && recipientPhones.length > 0) {
    return recipientPhones;
  }
  if (legacy?.trim()) return [legacy.trim()];
  return [""];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: WhatsappActionFormValues) => void;
  defaultValues?: {
    recipientPhones?: string[];
    recipientPhone?: string;
    message?: string;
  };
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
  const form = useForm<WhatsappActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      recipientPhones: toPhoneRows(
        defaultValues.recipientPhones,
        defaultValues.recipientPhone,
      ),
      message: defaultValues.message || "",
    },
  });

  // Reset form values when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        recipientPhones: toPhoneRows(
          defaultValues.recipientPhones,
          defaultValues.recipientPhone,
        ),
        message: defaultValues.message || "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: WhatsappActionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send WhatsApp</DialogTitle>
          <DialogDescription>
            Sends the same message to each recipient via your WhatsApp Business
            (Meta Cloud API) credential.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="recipientPhones"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Recipients</FormLabel>
                  <FormControl>
                    <RecipientList
                      value={field.value}
                      onChange={field.onChange}
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      placeholder="911234567890 or !#field#!"
                    />
                  </FormControl>
                  <FormDescription>
                    One row per recipient. Use the full number with country code
                    and no plus sign, or insert a field with the{" "}
                    <span className="font-mono">{"{ }"}</span> button.
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
                      placeholder="Hi !#telegram.from.firstName#!, …"
                      className="min-h-[100px] text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Insert data from earlier steps with the{" "}
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
