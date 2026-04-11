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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTRPC } from "@/trpc/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";

const formSchema = z.object({
  videoId: z.string().optional(),
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
  const trpc = useTRPC();
  const { data: videos = [], isLoading: isVideosLoading } = useQuery(
    trpc.credentials.getYoutubeVideos.queryOptions(),
  );

  const form = useForm<YoutubeCommentTriggerFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      videoId: defaultValues.videoId ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        videoId: defaultValues.videoId ?? "",
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
            video. Optionally limit to one video.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Make sure your YouTube account is connected under Credentials before
          configuring this node.
        </p>

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
                  <FormLabel>Video</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value || "__all__"}
                      onValueChange={(value) =>
                        field.onChange(value === "__all__" ? "" : value)
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            isVideosLoading
                              ? "Loading your videos..."
                              : "Leave empty to trigger on all videos"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All videos</SelectItem>
                        {videos.map((video) => (
                          <SelectItem key={video.videoId} value={video.videoId}>
                            {video.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormDescription>
                    Choose one of your uploaded videos, or leave as All videos
                    to trigger on comments from any video.
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
