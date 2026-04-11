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
import { Input } from "@/components/ui/input";
import { VariableTextarea } from "@/components/variable-textarea";
import z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

const formSchema = z.object({
  username: z.string().optional(),
  content: z
    .string()
    .min(1, "Message content is required")
    .max(2000, "Discord messages cannot exceed 2000 characters"),
  webhookUrl: z.string().min(1, "Webhook URL is required"),
});

export type DiscordFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: z.infer<typeof formSchema>) => void;
  defaultValues?: Partial<DiscordFormValues>;
  currentNodeId: string;
  workflowId?: string;
};

export const DiscordDialog = ({
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
      username: defaultValues.username || "",
      content: defaultValues.content || "",
      webhookUrl: defaultValues.webhookUrl || "",
    },
  });

  // Reset form values when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        username: defaultValues.username || "",
        content: defaultValues.content || "",
        webhookUrl: defaultValues.webhookUrl || "",
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
          <DialogTitle>Discord Configuration</DialogTitle>
          <DialogDescription>
            Configure the Discord webhook settings for this node.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-8 mt-4"
          >
            <FormField
              control={form.control}
              name="webhookUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Webhook URL</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://discord.com/api/webhooks/..."
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Get this from Discord: Channel Settings → Integrations → Webhooks
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
                <FormLabel>Message Content</FormLabel>
                <FormControl>
                  <VariableTextarea
                    placeholder="Summary: {{myGemini.text}}"
                    className="min-h-[80px] font-mono text-sm"
                    currentNodeId={currentNodeId}
                    workflowId={workflowId}
                    {...field}
                  />
                </FormControl>
                  <FormDescription>
                    The message to send. Use {"{{variables}}"} for simple values
                    or {"{{json variable}}"} to stringify objects
                  </FormDescription>
                <FormMessage />
              </FormItem>
            )}
            />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bot Username (Optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Workflow Bot"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Override the webhook's default username
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
