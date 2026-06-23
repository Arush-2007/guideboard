"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { toast } from "sonner";
import { useTRPC } from "@/trpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const aiReplySettingsSchema = z.object({
  accountDescription: z.string().optional(),
  replyTone: z.string().optional(),
  replyGoal: z.string().optional(),
});

type AiReplySettingsValues = z.infer<typeof aiReplySettingsSchema>;

const REPLY_TONES = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "funny", label: "Funny" },
  { value: "casual", label: "Casual" },
];

export const InstagramSettings = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isPending } = useQuery(trpc.aiReplySettings.get.queryOptions());

  const save = useMutation(
    trpc.aiReplySettings.save.mutationOptions({
      onSuccess: () => {
        toast.success("Settings saved");
        queryClient.invalidateQueries(trpc.aiReplySettings.get.queryOptions());
      },
      onError: (error) => {
        toast.error(`Failed to save settings: ${error.message}`);
      },
    }),
  );

  const form = useForm<AiReplySettingsValues>({
    resolver: zodResolver(aiReplySettingsSchema),
    defaultValues: {
      accountDescription: "",
      replyTone: "",
      replyGoal: "",
    },
  });

  useEffect(() => {
    if (!data) return;
    form.reset({
      accountDescription: data.accountDescription ?? "",
      replyTone: data.replyTone ?? "",
      replyGoal: data.replyGoal ?? "",
    });
  }, [data, form]);

  const onSubmit = (values: AiReplySettingsValues) => {
    save.mutate(values);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure how the AI Reply Generator responds across all platforms.
        </p>
      </div>

      <Card className="rounded-3xl border border-primary/20 bg-card/90 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
              <Image
                src="/logos/xai.svg"
                alt="AI Reply Settings"
                width={22}
                height={22}
                unoptimized
              />
            </span>
            AI Reply Settings
          </CardTitle>
          <CardDescription>
            Tell Guideboard about your account so it can craft better automated
            replies across Instagram, YouTube, and other platforms.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {isPending ? (
            <p className="text-sm text-muted-foreground">Loading settings…</p>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-5"
              >
                <FormField
                  control={form.control}
                  name="accountDescription"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Account Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="e.g. A sneaker reselling account that sells limited edition shoes"
                          className="min-h-[80px] resize-none"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="replyTone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reply Tone</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select a tone" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REPLY_TONES.map((tone) => (
                            <SelectItem key={tone.value} value={tone.value}>
                              {tone.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="replyGoal"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reply Goal</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="e.g. Always push interested buyers to DM for pricing"
                          className="min-h-[80px] resize-none"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-end pt-1">
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save settings"}
                  </Button>
                </div>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
