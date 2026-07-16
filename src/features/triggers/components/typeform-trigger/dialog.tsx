"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";
import { useTRPC } from "@/trpc/client";

/** A discovered field, stored so the variable picker can expose it. */
type DiscoveredField = { path: string; label: string };

type TypeformTriggerValues = {
  credentialId?: string;
  formId?: string;
  formTitle?: string;
  discoveredFields?: DiscoveredField[];
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: TypeformTriggerValues) => void;
  defaultValues?: TypeformTriggerValues;
  currentNodeId: string;
}

export const TypeformTriggerDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const trpc = useTRPC();
  const params = useParams();
  const workflowId = params.workflowId as string;

  const [credentialId, setCredentialId] = useState(
    defaultValues.credentialId ?? "",
  );
  const [formId, setFormId] = useState(defaultValues.formId ?? "");
  const [formTitle, setFormTitle] = useState(defaultValues.formTitle ?? "");
  const [fields, setFields] = useState<DiscoveredField[]>(
    defaultValues.discoveredFields ?? [],
  );
  const [verifyRequested, setVerifyRequested] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setCredentialId(defaultValues.credentialId ?? "");
      setFormId(defaultValues.formId ?? "");
      setFormTitle(defaultValues.formTitle ?? "");
      setFields(defaultValues.discoveredFields ?? []);
      setVerifyRequested(false);
      setTableOpen(false);
    }
  }, [open, defaultValues]);

  const { data: credentials = [] } = useCredentialsByType(
    CredentialType.TYPEFORM,
  );

  const { data: forms = [], isLoading: formsLoading } = useQuery({
    ...trpc.credentials.getTypeforms.queryOptions({ credentialId }),
    enabled: Boolean(credentialId),
  });

  const fieldsQuery = useQuery({
    ...trpc.credentials.getTypeformFields.queryOptions({
      credentialId,
      formId,
    }),
    enabled: verifyRequested && Boolean(credentialId) && Boolean(formId),
  });

  // When fields arrive, expose them as discoverable references (keyed by `ref`,
  // matching the webhook payload's answer keys) and reveal the table.
  useEffect(() => {
    if (fieldsQuery.data) {
      setFields(
        fieldsQuery.data.map((f) => ({
          path: `typeform.fields.${f.ref}`,
          label: f.title,
        })),
      );
      setTableOpen(true);
    }
  }, [fieldsQuery.data]);

  useEffect(() => {
    if (fieldsQuery.error) {
      toast.error(
        "Couldn't load fields. Check the Typeform credential's scopes (Forms: Read).",
      );
    }
  }, [fieldsQuery.error]);

  // Live webhook status, so reopening the dialog reflects an already-active
  // webhook (mutation state is in-memory only). Active if Typeform has our tag.
  const webhookStatus = useQuery({
    ...trpc.credentials.getTypeformWebhookStatus.queryOptions({
      credentialId,
      formId,
      workflowId,
    }),
    enabled: open && Boolean(credentialId) && Boolean(formId),
  });

  const activateWebhook = useMutation(
    trpc.credentials.registerTypeformWebhook.mutationOptions({
      onSuccess: () => {
        toast.success("Webhook activated on Typeform");
        webhookStatus.refetch();
      },
      onError: (e) => toast.error(`Couldn't activate webhook: ${e.message}`),
    }),
  );

  // Active if Typeform currently has our tag, or we just registered it.
  const webhookActive =
    activateWebhook.isSuccess || webhookStatus.data?.active === true;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Reference copied");
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handleSave = () => {
    onSubmit({ credentialId, formId, formTitle, discoveredFields: fields });
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>Typeform Trigger</DialogTitle>
            <DialogDescription>
              Connect a Typeform, pick a form, then activate the webhook — no
              manual setup in Typeform.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label>Typeform account</Label>
              {credentials.length === 0 ? (
                <div className="rounded-md border border-yellow-500/40 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                  <p>
                    No Typeform credential found. Add a Personal Access Token
                    (Forms: Read + Webhooks: Read, Write) first.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => window.open("/credentials/new", "_blank")}
                  >
                    Add Credential
                  </Button>
                </div>
              ) : (
                <Select
                  value={credentialId}
                  onValueChange={(id) => {
                    setCredentialId(id);
                    setFormId("");
                    setFormTitle("");
                    setFields([]);
                    setVerifyRequested(false);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a credential" />
                  </SelectTrigger>
                  <SelectContent>
                    {credentials.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label>Choose form &amp; load its fields</Label>
              <div className="flex gap-2">
                <Select
                  value={formId}
                  disabled={!credentialId || formsLoading}
                  onValueChange={(id) => {
                    setFormId(id);
                    setFormTitle(forms.find((f) => f.id === id)?.name ?? "");
                    setFields([]);
                    setVerifyRequested(false);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        !credentialId
                          ? "Pick a credential first"
                          : formsLoading
                            ? "Loading forms..."
                            : "Select a form"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {forms.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!formId || fieldsQuery.isFetching}
                  onClick={() => {
                    setVerifyRequested(true);
                    if (verifyRequested) fieldsQuery.refetch();
                  }}
                >
                  {fieldsQuery.isFetching ? "Loading…" : "Load fields"}
                </Button>
              </div>
              {fields.length > 0 ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => setTableOpen(true)}
                >
                  {fields.length} fields loaded — view
                </button>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Activate the trigger</Label>
              <p className="text-xs text-muted-foreground">
                Registers the webhook on Typeform so each submission starts this
                workflow. No copy-pasting into Typeform's settings.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={!credentialId || !formId || activateWebhook.isPending}
                onClick={() =>
                  activateWebhook.mutate({ credentialId, formId, workflowId })
                }
              >
                {webhookActive ? (
                  <CheckCircle2 className="mr-2 size-4 text-green-600" />
                ) : null}
                {activateWebhook.isPending
                  ? "Activating…"
                  : webhookActive
                    ? "Webhook active — re-activate"
                    : "Activate webhook"}
              </Button>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" onClick={handleSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fields open in their own wider window so long questions get a roomy,
          comfortable line. Closed via the built-in top-right X. */}
      <Dialog open={tableOpen} onOpenChange={setTableOpen}>
        <DialogContent className="max-h-[80vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Fields in {formTitle || "this form"}</DialogTitle>
            <DialogDescription>
              These are now available in the variable picker for this node.
            </DialogDescription>
          </DialogHeader>
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No fields found on this form.
            </p>
          ) : (
            <div className="space-y-2">
              {fields.map((f) => (
                <div key={f.path} className="rounded-md border p-3">
                  <p className="text-sm font-medium leading-relaxed">
                    {f.label}
                  </p>
                  <button
                    type="button"
                    className="mt-1 inline-block"
                    onClick={() => copy(`@<${f.path}>@`)}
                    title="Copy reference"
                  >
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {`@<${f.path}>@`}
                    </code>
                  </button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
