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
import { VariableTextarea } from "@/components/variable-textarea";
import z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { CredentialType } from "@/generated/prisma";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Image from "next/image";

const providerSchema = z.enum(["openai", "anthropic", "gemini"]);

const formSchema = z.object({
  provider: providerSchema,
  credentialId: z.string().min(1, "Credential is required"),
  systemPrompt: z.string().optional(),
  prompt: z.string().min(1, "Prompt is required"),
});

export type AiTextFormValues = z.infer<typeof formSchema>;

function credentialTypeForProvider(
  p: z.infer<typeof providerSchema>,
): CredentialType {
  switch (p) {
    case "openai":
      return CredentialType.OPENAI;
    case "anthropic":
      return CredentialType.ANTHROPIC;
    case "gemini":
      return CredentialType.GEMINI;
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: AiTextFormValues) => void;
  defaultValues?: Partial<AiTextFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const AiTextDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<AiTextFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      provider: defaultValues.provider ?? "openai",
      credentialId: defaultValues.credentialId ?? "",
      systemPrompt: defaultValues.systemPrompt ?? "",
      prompt: defaultValues.prompt ?? "",
    },
  });

  const provider = form.watch("provider");
  const credentialType = credentialTypeForProvider(provider);
  const { data: credentials = [], isLoading } =
    useCredentialsByType(credentialType);
  const autoSelected = credentials.length === 1 ? credentials[0] : null;

  const prevProviderRef = useRef(provider);

  useEffect(() => {
    if (open) {
      form.reset({
        provider: defaultValues.provider ?? "openai",
        credentialId: defaultValues.credentialId ?? "",
        systemPrompt: defaultValues.systemPrompt ?? "",
        prompt: defaultValues.prompt ?? "",
      });
      prevProviderRef.current = defaultValues.provider ?? "openai";
    }
  }, [open, defaultValues, form]);

  useEffect(() => {
    if (prevProviderRef.current !== provider) {
      form.setValue("credentialId", "");
      prevProviderRef.current = provider;
    }
  }, [provider, form]);

  useEffect(() => {
    if (autoSelected) {
      form.setValue("credentialId", autoSelected.id, {
        shouldValidate: true,
      });
    }
  }, [autoSelected, form]);

  const handleSubmit = (values: AiTextFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  const credentialLabel =
    provider === "openai"
      ? "OPENAI"
      : provider === "anthropic"
        ? "ANTHROPIC"
        : "GEMINI";

  const logoSrc =
    provider === "openai"
      ? "/logos/openai.svg"
      : provider === "anthropic"
        ? "/logos/anthropic.svg"
        : "/logos/gemini.svg";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AI</DialogTitle>
          <DialogDescription>
            Choose a provider, connect a credential, and set your prompts.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-8 mt-4"
          >
            <FormField
              control={form.control}
              name="provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="gemini">Gemini</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="credentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Credential</FormLabel>
                  {isLoading ? (
                    <Select value="" disabled>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Loading credentials..." />
                        </SelectTrigger>
                      </FormControl>
                    </Select>
                  ) : credentials.length === 0 ? (
                    <div className="rounded-md border border-yellow-500/40 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                      <p>
                        No {credentialLabel} credential found. Set one up first.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() =>
                          window.open("/credentials/new", "_blank")
                        }
                      >
                        Add Credential
                      </Button>
                    </div>
                  ) : autoSelected ? (
                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      Using: {autoSelected.name}
                    </div>
                  ) : (
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a credential" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {credentials.map((credential) => (
                          <SelectItem
                            key={credential.id}
                            value={credential.id}
                          >
                            <div className="flex items-center gap-2">
                              <Image
                                src={logoSrc}
                                alt={credentialLabel}
                                width={16}
                                height={16}
                              />
                              {credential.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="systemPrompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>System Prompt (optional)</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="You are a helpful assistant."
                      className="min-h-[80px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Sets the AI behavior and tone
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="prompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Prompt</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="Summarize this text: {{json httpResponse.data}}"
                      className="min-h-[120px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Supports {"{{variables}}"} from previous nodes
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
      </DialogContent>
    </Dialog>
  );
};
