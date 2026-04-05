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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";

const formSchema = z.object({
  replyMessage: z.string().min(1, "Reply message is required"),
});

export type YoutubeReplyFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: YoutubeReplyFormValues) => void;
  defaultValues?: Partial<YoutubeReplyFormValues>;
}

export const YoutubeReplyDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>YouTube Reply Configuration</DialogTitle>
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
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-8"
          >
            <FormField
              control={form.control}
              name="replyMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reply Message</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Your reply... use {{commenterName}} and {{commentText}}"
                      className="min-h-[90px] font-mono text-sm"
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
              <Button
                type="submit"
                style={{ backgroundColor: "#FF0000", color: "#fff" }}
                className="hover:opacity-90"
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
