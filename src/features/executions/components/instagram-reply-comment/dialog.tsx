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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";

const formSchema = z.object({
  variableName: z
    .string()
    .min(1, { message: "Variable name is required" })
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      message:
        "Variable name must start with a letter or underscore and contain only letters, numbers, and underscores",
    }),
  replyMessage: z
    .string()
    .min(1, "Reply message is required"),
});

export type InstagramReplyFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: InstagramReplyFormValues) => void;
  defaultValues?: Partial<InstagramReplyFormValues>;
}

export const InstagramReplyDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const form = useForm<InstagramReplyFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      variableName: defaultValues.variableName ?? "",
      replyMessage: defaultValues.replyMessage ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        variableName: defaultValues.variableName ?? "",
        replyMessage: defaultValues.replyMessage ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const watchVariableName = form.watch("variableName") || "instagramReply";

  const handleSubmit = (values: InstagramReplyFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Instagram Reply Configuration</DialogTitle>
          <DialogDescription>
            Configure the reply to post on an Instagram comment. Uses the
            Instagram account connected in Credentials.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-8 mt-4"
          >
            <FormField
              control={form.control}
              name="variableName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Variable Name</FormLabel>
                  <FormControl>
                    <Input placeholder="instagramReply" {...field} />
                  </FormControl>
                  <FormDescription>
                    Reference the result in later nodes:{" "}
                    <code className="bg-muted px-1 py-0.5 rounded text-xs">
                      {`{{${watchVariableName}.replyText}}`}
                    </code>
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
                      placeholder="Your reply... use {{commenterName}} and {{commentText}}"
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

            <DialogFooter className="mt-4">
              <Button
                type="submit"
                style={{ backgroundColor: "#E1306C", color: "#fff" }}
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
