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
  replyMessage: z.string().min(1, "Reply message is required"),
  variableName: z
    .string()
    .min(1, { message: "Variable name is required" })
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
      message:
        "Variable name must start with a letter or underscore and contain only letters, numbers, and underscores",
    }),
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
      variableName: defaultValues.variableName ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        replyMessage: defaultValues.replyMessage ?? "",
        variableName: defaultValues.variableName ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const watchVariableName = form.watch("variableName") || "youtubeReply";

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
            account connected in Credentials.
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

            <FormField
              control={form.control}
              name="variableName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Variable Name</FormLabel>
                  <FormControl>
                    <Input placeholder="youtubeReply" {...field} />
                  </FormControl>
                  <FormDescription>
                    Reference the result in later nodes:{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">
                      {`{{${watchVariableName}.replyText}}`}
                    </code>
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
