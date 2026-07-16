"use client";

import { useQuery } from "@tanstack/react-query";
import { CopyIcon, ExternalLink } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WideOverlayPanel } from "@/components/wide-overlay-panel";
import { useTRPC } from "@/trpc/client";
import { generateGoogleFormScript } from "./utils";

/** A discovered question, stored so the variable picker can expose it. */
type DiscoveredField = { path: string; label: string };

type GoogleFormTriggerValues = {
  formId?: string;
  formTitle?: string;
  discoveredFields?: DiscoveredField[];
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GoogleFormTriggerValues) => void;
  defaultValues?: GoogleFormTriggerValues;
  currentNodeId: string;
}

export const GoogleFormTriggerDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
}: Props) => {
  const trpc = useTRPC();
  const params = useParams();
  const workflowId = params.workflowId as string;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/webhooks/google-form?workflowId=${workflowId}`;

  const [formId, setFormId] = useState(defaultValues.formId ?? "");
  const [formTitle, setFormTitle] = useState(defaultValues.formTitle ?? "");
  const [fields, setFields] = useState<DiscoveredField[]>(
    defaultValues.discoveredFields ?? [],
  );
  const [verifyRequested, setVerifyRequested] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setFormId(defaultValues.formId ?? "");
      setFormTitle(defaultValues.formTitle ?? "");
      setFields(defaultValues.discoveredFields ?? []);
      setVerifyRequested(false);
      setTableOpen(false);
    }
  }, [open, defaultValues]);

  const { data: forms = [], isLoading: formsLoading } = useQuery(
    trpc.credentials.getGoogleForms.queryOptions(),
  );

  const questionsQuery = useQuery({
    ...trpc.credentials.getGoogleFormQuestions.queryOptions({ formId }),
    enabled: verifyRequested && Boolean(formId),
  });

  // When questions arrive, turn them into discoverable fields (keyed by title,
  // matching the Apps Script's `responses` keys) and reveal the table.
  useEffect(() => {
    if (questionsQuery.data) {
      setFields(
        questionsQuery.data.map((q) => ({
          path: `googleForm.responses.${q.title}`,
          label: q.title,
        })),
      );
      setTableOpen(true);
    }
  }, [questionsQuery.data]);

  useEffect(() => {
    if (questionsQuery.error) {
      toast.error(
        "Couldn't load questions. Make sure you've re-connected Google (the Forms permission is new).",
      );
    }
  }, [questionsQuery.error]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  };

  const handleSave = () => {
    onSubmit({ formId, formTitle, discoveredFields: fields });
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh]">
          <DialogHeader>
            <EditableNodeTitle nodeId={currentNodeId} />
            <DialogDescription>
              Connect a Google Form to start this workflow. The two steps below
              are independent — do them in either order.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label>Choose form &amp; load its questions</Label>
              <p className="text-xs text-muted-foreground">
                Reads the form's questions directly (no script needed) so you
                can reference each answer downstream.
              </p>
              <div className="flex gap-2">
                <Select
                  value={formId}
                  disabled={formsLoading}
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
                        formsLoading ? "Loading forms..." : "Select a form"
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
                  disabled={!formId || questionsQuery.isFetching}
                  onClick={() => {
                    setVerifyRequested(true);
                    if (verifyRequested) questionsQuery.refetch();
                  }}
                >
                  {questionsQuery.isFetching ? "Loading…" : "Load questions"}
                </Button>
              </div>
              {fields.length > 0 ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => setTableOpen(true)}
                >
                  {fields.length} questions loaded — view
                </button>
              ) : null}
              <p className="text-xs text-muted-foreground">
                The picker also offers{" "}
                <span className="font-medium">Respondent email</span>, but
                Google only sends it when your form's{" "}
                <span className="font-medium">
                  Settings → Collect email addresses
                </span>{" "}
                is on — otherwise it arrives empty.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Make submissions trigger this workflow</Label>
              <p className="text-xs text-muted-foreground">
                Add a small Apps Script to the form so each submission starts
                this workflow.
              </p>
              <div className="flex flex-wrap gap-2">
                {formId ? (
                  <Button type="button" variant="outline" asChild>
                    <a
                      href={`https://docs.google.com/forms/d/${formId}/edit`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="mr-2 size-4" />
                      Open your form
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    copy(generateGoogleFormScript(webhookUrl), "Apps Script")
                  }
                >
                  <CopyIcon className="mr-2 size-4" />
                  Copy Apps Script
                </Button>
              </div>
              <ol className="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
                <li>Open your form → ⋮ menu → Apps Script</li>
                <li>Paste the script and Save</li>
                <li>
                  Run <span className="font-mono">setup</span> once (Run ▸
                  setup) — it self-installs the submit trigger
                </li>
              </ol>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" onClick={handleSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Questions open in their own WIDER window layered on top of the config,
          so long questions get a roomy full-width line (comfortable to read).
          Closed via the built-in top-right X. */}
      <WideOverlayPanel
        open={tableOpen}
        onOpenChange={setTableOpen}
        title={`Questions in ${formTitle || "this form"}`}
        description="These are now available in the variable picker for this node."
      >
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No questions found on this form.
          </p>
        ) : (
          <div className="space-y-2">
            {fields.map((f) => (
              <div key={f.path} className="rounded-md border p-3">
                <p className="text-sm font-medium leading-relaxed">{f.label}</p>
                <button
                  type="button"
                  className="mt-1 inline-block"
                  onClick={() => copy(`@<${f.path}>@`, "Reference")}
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
      </WideOverlayPanel>
    </>
  );
};
