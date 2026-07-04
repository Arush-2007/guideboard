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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableTextarea } from "@/components/variable-textarea";
import { INTEGRATIONS } from "@/config/integrations";
import { useSmartCredential } from "@/features/credentials/hooks/use-smart-credential";
import { CredentialType } from "@/generated/prisma";

const formSchema = z.object({
  credentialId: z.string().min(1, "Credential is required"),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().min(1, "User prompt is required"),
});

export type OpenAiFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: z.infer<typeof formSchema>) => void;
  defaultValues?: Partial<OpenAiFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const OpenAiDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const { credentials, isLoading, autoSelected } = useSmartCredential(
    CredentialType.OPENAI,
  );

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      credentialId: defaultValues.credentialId || "",
      systemPrompt: defaultValues.systemPrompt || "",
      userPrompt: defaultValues.userPrompt || "",
    },
  });

  // Reset form values when dialog opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        credentialId: defaultValues.credentialId || "",
        systemPrompt: defaultValues.systemPrompt || "",
        userPrompt: defaultValues.userPrompt || "",
      });
    }
  }, [open, defaultValues, form]);

  useEffect(() => {
    if (autoSelected) {
      form.setValue("credentialId", autoSelected.id, {
        shouldValidate: true,
      });
    }
  }, [autoSelected, form]);

  const handleSubmit = (values: z.infer<typeof formSchema>) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>OpenAI</DialogTitle>
          <DialogDescription>
            Configure the AI model and prompts for this node.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-8 mt-4"
          >
            <FormField
              control={form.control}
              name="credentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>OpenAI Credential</FormLabel>
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
                      <p>No OPENAI credential found. Set one up first.</p>
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
                                src={INTEGRATIONS.openai.icon}
                                alt={INTEGRATIONS.openai.label}
                                width={16}
                                height={16}
                                unoptimized
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
                  <FormLabel>System Prompt (Optional)</FormLabel>
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
                    Sets the behavior of the assistant. Use {"{{variables}}"}{" "}
                    for simple values or {"{{json variable}}"} to stringify
                    objects
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="userPrompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>User Prompt</FormLabel>
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
                    The prompt to send to the AI. Use {"{{variables}}"} for
                    simple values or {"{{json variable}}"} to stringify objects
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
