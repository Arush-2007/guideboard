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
import { VariableTextarea } from "@/components/variable-textarea";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";

const formSchema = z.object({
  provider: z.enum(["lever"]),
  environment: z.enum(["sandbox", "production"]),
  credentialId: z.string().min(1, "A credential is required"),
  performAsUserId: z.string().min(1, "A 'perform as' user id is required"),
  name: z.string().min(1, "Candidate name is required"),
  email: z.string().optional(),
  resumeUrl: z.string().optional(),
  note: z.string().optional(),
  stageId: z.string().optional(),
  postingId: z.string().optional(),
});

export type AtsActionFormValues = z.infer<typeof formSchema>;

function defaults(v: Partial<AtsActionFormValues>): AtsActionFormValues {
  return {
    provider: v.provider ?? "lever",
    environment: v.environment ?? "sandbox",
    credentialId: v.credentialId ?? "",
    performAsUserId: v.performAsUserId ?? "",
    name: v.name ?? "@<applicant.name>@",
    email: v.email ?? "@<applicant.email>@",
    resumeUrl: v.resumeUrl ?? "@<applicant.resumeUrl>@",
    note: v.note ?? "Screening: @<CANDIDATE_SCORING_1.reasons>@",
    stageId: v.stageId ?? "",
    postingId: v.postingId ?? "",
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: AtsActionFormValues) => void;
  defaultValues?: Partial<AtsActionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const AtsActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<AtsActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(defaultValues),
  });
  const { data: credentials = [] } = useCredentialsByType(CredentialType.LEVER);

  useEffect(() => {
    if (open) form.reset(defaults(defaultValues));
  }, [open, defaultValues, form]);

  const handleSubmit = (values: AtsActionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh]">
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Pushes a shortlisted candidate into your ATS (Lever), attaching
            their resume link and the screening note.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(guard.save)}
            className="mt-4 space-y-5"
          >
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>ATS</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="lever">Lever</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="environment"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Environment</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="sandbox">Sandbox</SelectItem>
                        <SelectItem value="production">Production</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="credentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lever credential</FormLabel>
                  {credentials.length === 0 ? (
                    <div className="rounded-md border border-yellow-500/40 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                      <p>No Lever credential found. Add one first.</p>
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
                    <Select onValueChange={field.onChange} value={field.value}>
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
              name="performAsUserId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Perform as (Lever user id)</FormLabel>
                  <FormControl>
                    <Input placeholder="Lever user id" {...field} />
                  </FormControl>
                  <FormDescription>
                    Lever attributes API actions to a user — paste a Lever user
                    id from your account.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Candidate name</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="@<applicant.name>@"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="@<applicant.email>@"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="resumeUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Resume link</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="@<applicant.resumeUrl>@"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (screening summary)</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="Screening: @<CANDIDATE_SCORING_1.reasons>@"
                      className="min-h-[80px] text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="stageId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stage id (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="Lever stage id" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="postingId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Posting id (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="Lever posting id" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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
