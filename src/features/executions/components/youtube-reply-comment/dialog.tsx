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
import { VariableTextarea } from "@/components/variable-textarea";

const formSchema = z.object({
  replyMessage: z.string().min(1, "Reply message is required"),
});

export type YoutubeReplyFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: YoutubeReplyFormValues) => void;
  defaultValues?: Partial<YoutubeReplyFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const YoutubeReplyDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<YoutubeReplyFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      replyMessage: defaultValues.replyMessage ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        replyMessage: defaultValues.replyMessage ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: YoutubeReplyFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Configure the reply to post on a YouTube comment. Uses the YouTube
            account connected in Credentials. Use{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {"{{aiReply.text}}"}
            </code>{" "}
            after an AI Reply Generator step.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(guard.save)}
            className="mt-4 space-y-8"
          >
            <FormField
              control={form.control}
              name="replyMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reply Message</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="Your reply... use {{commenterName}} and {{commentText}}"
                      className="min-h-[90px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The reply to post. Use{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">
                      {"{{commenterName}}"}
                    </code>{" "}
                    and{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">
                      {"{{commentText}}"}
                    </code>{" "}
                    as placeholders.
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
