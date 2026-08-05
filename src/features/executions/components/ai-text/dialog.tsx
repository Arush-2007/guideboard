"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Image from "next/image";
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { useDanglingRefGuard } from "@/components/dangling-ref-guard";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
import { VariableTextarea } from "@/components/variable-textarea";
import { INTEGRATIONS } from "@/config/integrations";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";

const providerSchema = z.enum(["openai", "anthropic", "gemini", "groq"]);

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
    case "groq":
      return CredentialType.GROQ;
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

  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

  const credentialLabel =
    provider === "openai"
      ? "OPENAI"
      : provider === "anthropic"
        ? "ANTHROPIC"
        : provider === "gemini"
          ? "GEMINI"
          : "GROQ";

  const logoSrc =
    provider === "openai"
      ? INTEGRATIONS.openai.icon
      : provider === "anthropic"
        ? INTEGRATIONS.anthropic.icon
        : provider === "gemini"
          ? INTEGRATIONS.gemini.icon
          : INTEGRATIONS.groq.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Pick a provider and credential, then describe what the AI should do
            with data from previous steps. Its result is available downstream as
            the node's "AI output".
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(guard.save)}
            className="space-y-8 mt-4"
          >
            <FormField
              control={form.control}
              name="provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="gemini">Gemini</SelectItem>
                      <SelectItem value="groq">Groq</SelectItem>
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
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a credential" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {credentials.map((credential) => (
                          <SelectItem key={credential.id} value={credential.id}>
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
                  <FormLabel>AI role (optional)</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="You are a precise classifier. Answer with a single word."
                      className="min-h-[80px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Sets the AI's behavior and tone
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
                  <FormLabel>Operation — what should the AI do?</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder={
                        "If @<telegram.text>@ is an internship application, reply with exactly: Yes — otherwise reply: No"
                      }
                      className="min-h-[120px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Describe the task in plain language. Use the{" "}
                    <span className="font-mono">{"{ }"}</span> button to insert
                    data from previous steps.
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
        {guard.dialog}
      </DialogContent>
    </Dialog>
  );
};
