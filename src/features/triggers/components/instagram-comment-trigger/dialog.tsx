"use client";

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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";

const formSchema = z.object({
  postId: z.string().optional(),
  keywordFilter: z.string().optional(),
  replyMessage: z.string().min(1, "Reply message is required"),
});

export type InstagramCommentTriggerFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: InstagramCommentTriggerFormValues) => void;
  defaultValues?: Partial<InstagramCommentTriggerFormValues>;
}

export const InstagramCommentTriggerDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const form = useForm<InstagramCommentTriggerFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      postId: defaultValues.postId ?? "",
      keywordFilter: defaultValues.keywordFilter ?? "",
      replyMessage: defaultValues.replyMessage ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        postId: defaultValues.postId ?? "",
        keywordFilter: defaultValues.keywordFilter ?? "",
        replyMessage: defaultValues.replyMessage ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: InstagramCommentTriggerFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle
            className="flex items-center gap-2"
            style={{ color: "#E1306C" }}
          >
            Instagram Comment Trigger
          </DialogTitle>
          <DialogDescription>
            Trigger this workflow when a comment is posted on your Instagram
            post. Optionally filter by post or keyword, and configure an auto
            reply.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-5 mt-2"
          >
            <FormField
              control={form.control}
              name="postId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Post ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Leave empty to trigger on all posts"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The Instagram post ID to watch. Leave blank to trigger on
                    any post.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="keywordFilter"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Keyword Filter</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. price, discount (leave empty for all comments)"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Comma-separated keywords. Only comments containing at least
                    one keyword will trigger the workflow. Leave blank to match
                    all comments.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="replyMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reply Message</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Your reply message... use {{commenterName}} and {{commentText}}"
                      className="min-h-[90px] font-mono text-sm"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The reply to post. Use{" "}
                    <code className="bg-muted px-1 py-0.5 rounded text-xs">
                      {"{{commenterName}}"}
                    </code>{" "}
                    and{" "}
                    <code className="bg-muted px-1 py-0.5 rounded text-xs">
                      {"{{commentText}}"}
                    </code>{" "}
                    as placeholders.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="submit"
                style={{
                  backgroundColor: "#E1306C",
                  color: "#fff",
                }}
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
