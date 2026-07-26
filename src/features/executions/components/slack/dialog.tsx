"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { RecipientList } from "@/components/recipient-list";
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
import { VariableTextarea } from "@/components/variable-textarea";

const formSchema = z.object({
  webhookUrls: z
    .array(z.string())
    .transform((arr) => arr.map((s) => s.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "Add at least one webhook URL"),
  content: z.string().min(1, "Message content is required"),
});

export type SlackFormValues = z.infer<typeof formSchema>;

/** Accepts the new array shape or a legacy single `webhookUrl` string. */
function toWebhookRows(
  webhookUrls: string[] | undefined,
  legacy: string | undefined,
): string[] {
  if (Array.isArray(webhookUrls) && webhookUrls.length > 0) return webhookUrls;
  if (legacy?.trim()) return [legacy.trim()];
  return [""];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: SlackFormValues) => void;
  defaultValues?: {
    webhookUrls?: string[];
    webhookUrl?: string;
    content?: string;
  };
  currentNodeId: string;
  workflowId?: string;
}

export const SlackDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<SlackFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      webhookUrls: toWebhookRows(
        defaultValues.webhookUrls,
        defaultValues.webhookUrl,
      ),
      content: defaultValues.content || "",
    },
  });

  // Reset form values when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        webhookUrls: toWebhookRows(
          defaultValues.webhookUrls,
          defaultValues.webhookUrl,
        ),
        content: defaultValues.content || "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: SlackFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Posts the same message to each webhook. Each Incoming Webhook is
            tied to one channel — add one per channel you want to notify.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="webhookUrls"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Webhook URLs</FormLabel>
                  <FormControl>
                    <RecipientList
                      value={field.value}
                      onChange={field.onChange}
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      placeholder="https://hooks.slack.com/services/..."
                      addLabel="Add channel"
                    />
                  </FormControl>
                  <FormDescription>
                    In Slack: api.slack.com/apps → your app → Incoming Webhooks
                    → Add New Webhook → copy the URL (one per channel).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="New application from @<telegram.from.firstName>@ — please review"
                      className="min-h-[100px] text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Insert data from earlier steps with the{" "}
                    <span className="font-mono">{"{ }"}</span> button. To ping
                    teammates, @mention them with{" "}
                    <span className="font-mono">{"<@U123>"}</span>.
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
