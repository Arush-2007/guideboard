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
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";

const formSchema = z.object({
  postId: z.string().optional(),
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
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        postId: defaultValues.postId ?? "",
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
            post. Optionally limit to one post, and configure an auto reply.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Make sure your Instagram account is connected under Credentials
          before configuring this node.
        </p>

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
