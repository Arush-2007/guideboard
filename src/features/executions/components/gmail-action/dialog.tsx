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
import { VariableInput } from "@/components/variable-input";
import { VariableTextarea } from "@/components/variable-textarea";

const formSchema = z.object({
  to: z
    .array(z.string())
    .transform((arr) => arr.map((s) => s.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "Add at least one recipient"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
});

export type GmailActionFormValues = z.infer<typeof formSchema>;

/** Accepts the new array shape or a legacy comma-separated string. */
function toRecipientRows(to: string | string[] | undefined): string[] {
  if (Array.isArray(to)) return to.length > 0 ? to : [""];
  if (typeof to === "string" && to.trim()) {
    return to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [""];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GmailActionFormValues) => void;
  defaultValues?: { to?: string | string[]; subject?: string; body?: string };
  currentNodeId: string;
  workflowId?: string;
}

export const GmailActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<GmailActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      to: toRecipientRows(defaultValues.to),
      subject: defaultValues.subject || "",
      body: defaultValues.body || "",
    },
  });

  // Reset form values when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        to: toRecipientRows(defaultValues.to),
        subject: defaultValues.subject || "",
        body: defaultValues.body || "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: GmailActionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compose email</DialogTitle>
          <DialogDescription>
            Sent from your connected Google account. Insert data from earlier
            steps with the <span className="font-mono">{"{ }"}</span> button —
            it drops in a <span className="font-mono">{"@<field>@"}</span>{" "}
            placeholder.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="to"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>To</FormLabel>
                  <FormControl>
                    <RecipientList
                      value={field.value}
                      onChange={field.onChange}
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      placeholder="name@example.com or @<field>@"
                    />
                  </FormControl>
                  <FormDescription>
                    Add one row per recipient. Each can be a fixed address or a
                    field from an earlier step.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="subject"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subject</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="Subject line"
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
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Body</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="Hi @<telegram.from.firstName>@, …"
                      className="min-h-[140px] text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
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
