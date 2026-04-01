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
  videoId: z.string().optional(),
  keywordFilter: z.string().optional(),
});

export type YoutubeCommentTriggerFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: YoutubeCommentTriggerFormValues) => void;
  defaultValues?: Partial<YoutubeCommentTriggerFormValues>;
}

export const YoutubeCommentTriggerDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const form = useForm<YoutubeCommentTriggerFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      videoId: defaultValues.videoId ?? "",
      keywordFilter: defaultValues.keywordFilter ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        videoId: defaultValues.videoId ?? "",
        keywordFilter: defaultValues.keywordFilter ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: YoutubeCommentTriggerFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle
            className="flex items-center gap-2"
            style={{ color: "#FF0000" }}
          >
            YouTube Comment Trigger
          </DialogTitle>
          <DialogDescription>
            Trigger this workflow when a comment is posted on your YouTube
            video. Optionally filter by video ID or keyword.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-2 space-y-5"
          >
            <FormField
              control={form.control}
              name="videoId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Video ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Leave empty to trigger on all videos"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The YouTube video ID to watch. Leave blank to trigger on
                    comments from any video.
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
                      placeholder="e.g. price, buy (leave empty for all comments)"
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

            <DialogFooter>
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
