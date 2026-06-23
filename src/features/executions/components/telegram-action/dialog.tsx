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
import { VariableInput } from "@/components/variable-input";
import { VariableTextarea } from "@/components/variable-textarea";
import z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useSmartCredential } from "@/features/credentials/hooks/use-smart-credential";
import { CredentialType } from "@/generated/prisma";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Image from "next/image";

const formSchema = z.object({
  credentialId: z.string().min(1, "Credential is required"),
  chatId: z.string().min(1, "Chat ID is required"),
  message: z
    .string()
    .min(1, "Message is required")
    .max(4096, "Telegram messages cannot exceed 4096 characters"),
});

export type TelegramActionFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: TelegramActionFormValues) => void;
  defaultValues?: Partial<TelegramActionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const TelegramActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const { credentials, isLoading, autoSelected } = useSmartCredential(
    CredentialType.TELEGRAM,
  );

  const form = useForm<TelegramActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      credentialId: defaultValues.credentialId || "",
      chatId: defaultValues.chatId || "",
      message: defaultValues.message || "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        credentialId: defaultValues.credentialId || "",
        chatId: defaultValues.chatId || "",
        message: defaultValues.message || "",
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

  const handleSubmit = (values: TelegramActionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Telegram</DialogTitle>
          <DialogDescription>
            Send a message with your bot via the Telegram Bot API.
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
                  <FormLabel>Bot credential</FormLabel>
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
                      <p>No TELEGRAM credential found. Set one up first.</p>
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
                          <SelectValue placeholder="Select a Telegram bot token" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {credentials.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            <div className="flex items-center gap-2">
                              <Image
                                src="/logos/telegram.svg"
                                alt=""
                                width={16}
                                height={16}
                                unoptimized
                              />
                              {c.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormDescription>
                    Add a Telegram bot token under Credentials.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="chatId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Chat ID</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="{{telegram.chatId}} or numeric id"
                      className="font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Use {"{{telegram.chatId}}"} to reply to whoever triggered
                    this workflow, or enter a fixed chat ID.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="message"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="Hello {{telegram.firstName}}"
                      className="min-h-[80px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Max 4096 characters. Use {"{{variables}}"} for context
                    values.
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
