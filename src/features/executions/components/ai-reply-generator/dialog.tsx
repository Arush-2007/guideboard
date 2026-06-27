"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Image from "next/image";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";

const NONE = "__none__";

const formSchema = z.object({
  keyword: z.string().optional(),
  replyToKeywordComments: z.boolean().optional(),
  keywordPrompt: z.string().optional(),
  replyToNonKeywordComments: z.boolean().optional(),
  defaultPrompt: z.string().optional(),
  postDescription: z.string().optional(),
  xaiCredentialId: z.string().optional(),
  geminiCredentialId: z.string().optional(),
  openaiCredentialId: z.string().optional(),
  groqCredentialId: z.string().optional(),
});

export type AiReplyGeneratorFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: AiReplyGeneratorFormValues) => void;
  defaultValues?: Partial<AiReplyGeneratorFormValues>;
}

export const AiReplyGeneratorDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const { data: xaiCredentials, isLoading: isLoadingXai } =
    useCredentialsByType(CredentialType.XAI);
  const { data: geminiCredentials, isLoading: isLoadingGemini } =
    useCredentialsByType(CredentialType.GEMINI);
  const { data: openaiCredentials, isLoading: isLoadingOpenai } =
    useCredentialsByType(CredentialType.OPENAI);
  const { data: groqCredentials, isLoading: isLoadingGroq } =
    useCredentialsByType(CredentialType.GROQ);

  const form = useForm<AiReplyGeneratorFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      keyword: defaultValues.keyword ?? "",
      replyToKeywordComments: defaultValues.replyToKeywordComments ?? true,
      keywordPrompt: defaultValues.keywordPrompt ?? "",
      replyToNonKeywordComments:
        defaultValues.replyToNonKeywordComments ?? true,
      defaultPrompt: defaultValues.defaultPrompt ?? "",
      postDescription: defaultValues.postDescription ?? "",
      xaiCredentialId: defaultValues.xaiCredentialId ?? "",
      geminiCredentialId: defaultValues.geminiCredentialId ?? "",
      openaiCredentialId: defaultValues.openaiCredentialId ?? "",
      groqCredentialId: defaultValues.groqCredentialId ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        keyword: defaultValues.keyword ?? "",
        replyToKeywordComments: defaultValues.replyToKeywordComments ?? true,
        keywordPrompt: defaultValues.keywordPrompt ?? "",
        replyToNonKeywordComments:
          defaultValues.replyToNonKeywordComments ?? true,
        defaultPrompt: defaultValues.defaultPrompt ?? "",
        postDescription: defaultValues.postDescription ?? "",
        xaiCredentialId: defaultValues.xaiCredentialId ?? "",
        geminiCredentialId: defaultValues.geminiCredentialId ?? "",
        openaiCredentialId: defaultValues.openaiCredentialId ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const watchReplyToKeyword = form.watch("replyToKeywordComments");
  const watchReplyToNonKeyword = form.watch("replyToNonKeywordComments");

  const handleSubmit = (values: AiReplyGeneratorFormValues) => {
    onSubmit({
      ...values,
      xaiCredentialId:
        values.xaiCredentialId === NONE ? "" : values.xaiCredentialId,
      geminiCredentialId:
        values.geminiCredentialId === NONE ? "" : values.geminiCredentialId,
      openaiCredentialId:
        values.openaiCredentialId === NONE ? "" : values.openaiCredentialId,
      groqCredentialId:
        values.groqCredentialId === NONE ? "" : values.groqCredentialId,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-foreground/10">
              <Image
                src="/logos/xai.svg"
                alt="AI"
                width={16}
                height={16}
                className="dark:invert"
                unoptimized
              />
            </span>
            AI Reply Generator
          </DialogTitle>
          <DialogDescription>
            Automatically generate contextual replies using AI based on keyword
            routing and your account settings. Downstream nodes can use{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {"{{aiReply.text}}"}
            </code>
            .
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            {/* Keyword */}
            <FormField
              control={form.control}
              name="keyword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Keyword (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. price, buy, cost" {...field} />
                  </FormControl>
                  <FormDescription>
                    Used to route comments into two separate reply tracks below.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Reply to keyword comments — toggle + conditional textarea */}
            <div className="space-y-3 rounded-xl border border-border p-4">
              <FormField
                control={form.control}
                name="replyToKeywordComments"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm">
                        Reply to comments with keyword
                      </FormLabel>
                      <FormDescription className="text-xs">
                        AI replies when the comment contains the keyword above.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {watchReplyToKeyword && (
                <FormField
                  control={form.control}
                  name="keywordPrompt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs text-muted-foreground">
                        Keyword reply instruction
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="e.g. Politely tell them to check their DMs for pricing"
                          className="min-h-[72px] resize-none text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            {/* Reply to non-keyword comments — toggle + conditional textarea */}
            <div className="space-y-3 rounded-xl border border-border p-4">
              <FormField
                control={form.control}
                name="replyToNonKeywordComments"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm">
                        Reply to comments without keyword
                      </FormLabel>
                      <FormDescription className="text-xs">
                        AI replies when the comment does NOT contain the
                        keyword.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {watchReplyToNonKeyword && (
                <FormField
                  control={form.control}
                  name="defaultPrompt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs text-muted-foreground">
                        Default reply instruction
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="e.g. Reply in a way that encourages them to engage in conversation"
                          className="min-h-[72px] resize-none text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            {/* Post Description */}
            <FormField
              control={form.control}
              name="postDescription"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Post / Video Description (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe this video/post for better AI context (optional)"
                      className="min-h-[72px] resize-none"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Gives the AI context about the specific post it is replying
                    on behalf of.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* AI provider helper */}
            <p className="rounded-xl border border-border bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
              AI will try <strong>xAI → Gemini → OpenAI → Groq</strong> in
              order. Add at least one credential.
            </p>

            {/* xAI credential */}
            <FormField
              control={form.control}
              name="xaiCredentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>xAI Credential (optional)</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || NONE}
                    disabled={isLoadingXai}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {xaiCredentials?.map((cred) => (
                        <SelectItem key={cred.id} value={cred.id}>
                          <div className="flex items-center gap-2">
                            <Image
                              src="/logos/xai.svg"
                              alt="xAI"
                              width={14}
                              height={14}
                              className="dark:invert"
                              unoptimized
                            />
                            {cred.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Gemini credential */}
            <FormField
              control={form.control}
              name="geminiCredentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Gemini Credential (optional)</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || NONE}
                    disabled={isLoadingGemini}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {geminiCredentials?.map((cred) => (
                        <SelectItem key={cred.id} value={cred.id}>
                          <div className="flex items-center gap-2">
                            <Image
                              src="/logos/gemini.svg"
                              alt="Gemini"
                              width={14}
                              height={14}
                              unoptimized
                            />
                            {cred.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* OpenAI credential */}
            <FormField
              control={form.control}
              name="openaiCredentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>OpenAI Credential (optional)</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || NONE}
                    disabled={isLoadingOpenai}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {openaiCredentials?.map((cred) => (
                        <SelectItem key={cred.id} value={cred.id}>
                          <div className="flex items-center gap-2">
                            <Image
                              src="/logos/openai.svg"
                              alt="OpenAI"
                              width={14}
                              height={14}
                              unoptimized
                            />
                            {cred.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Groq credential */}
            <FormField
              control={form.control}
              name="groqCredentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Groq Credential (optional)</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || NONE}
                    disabled={isLoadingGroq}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {groqCredentials?.map((cred) => (
                        <SelectItem key={cred.id} value={cred.id}>
                          <div className="flex items-center gap-2">
                            <Image
                              src="/logos/groq.svg"
                              alt="Groq"
                              width={14}
                              height={14}
                              unoptimized
                            />
                            {cred.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
