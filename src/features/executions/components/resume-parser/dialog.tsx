"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "@/components/variable-input";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";

const formSchema = z
  .object({
    provider: z.enum(["builtin", "affinda"]),
    sourceUrl: z.string().min(1, "Resume URL is required"),
    skillKeywords: z.string().optional(),
    credentialId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.provider === "affinda" && !data.credentialId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An Affinda credential is required",
        path: ["credentialId"],
      });
    }
  });

export type ResumeParserFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ResumeParserFormValues) => void;
  defaultValues?: Partial<ResumeParserFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const ResumeParserDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<ResumeParserFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      provider: defaultValues.provider ?? "builtin",
      sourceUrl: defaultValues.sourceUrl ?? "@<applicant.resumeUrl>@",
      skillKeywords: defaultValues.skillKeywords ?? "",
      credentialId: defaultValues.credentialId ?? "",
      workspaceId: defaultValues.workspaceId ?? "",
    },
  });

  const provider = form.watch("provider");
  const { data: credentials = [] } = useCredentialsByType(
    CredentialType.AFFINDA,
  );

  useEffect(() => {
    if (open) {
      form.reset({
        provider: defaultValues.provider ?? "builtin",
        sourceUrl: defaultValues.sourceUrl ?? "@<applicant.resumeUrl>@",
        skillKeywords: defaultValues.skillKeywords ?? "",
        credentialId: defaultValues.credentialId ?? "",
        workspaceId: defaultValues.workspaceId ?? "",
      });
    }
  }, [open, defaultValues, form]);

  const handleSubmit = (values: ResumeParserFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Pulls the applicant's resume and extracts its text + key fields,
            made available downstream for screening.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(guard.save)}
            className="mt-4 space-y-6"
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
                      <SelectItem value="builtin">
                        Built-in (free, text extraction)
                      </SelectItem>
                      <SelectItem value="affinda">
                        Affinda (structured parsing)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Built-in runs locally with no API key. Affinda returns rich
                    structured fields (needs an Affinda credential).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="sourceUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Resume URL</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="@<applicant.resumeUrl>@"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The uploaded resume link from the application. Insert it
                    with the <span className="font-mono">{"{ }"}</span> button.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {provider === "builtin" ? (
              <FormField
                control={form.control}
                name="skillKeywords"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Skill keywords (optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="React, TypeScript, Node.js, AWS"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Comma-separated skills to detect in the resume text.
                      Matches are exposed as "Detected skills".
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <>
                <FormField
                  control={form.control}
                  name="credentialId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Affinda credential</FormLabel>
                      {credentials.length === 0 ? (
                        <div className="rounded-md border border-yellow-500/40 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                          <p>No Affinda credential found. Add one first.</p>
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
                            {credentials.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
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
                  name="workspaceId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Affinda workspace ID (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="workspace identifier" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

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
