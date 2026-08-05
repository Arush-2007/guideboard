"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, RefreshCwIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTRPC } from "@/trpc/client";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentNodeId: string;
}

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const WebhookTriggerDialog = ({
  open,
  onOpenChange,
  currentNodeId,
}: Props) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useParams();
  const workflowId = params.workflowId as string;

  const getOptions = trpc.webhook.get.queryOptions(
    { workflowId },
    { enabled: open && !!workflowId },
  );
  const { data, isLoading } = useQuery(getOptions);

  const regenerate = useMutation(
    trpc.webhook.regenerate.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(getOptions);
        toast.success("Webhook URL regenerated — the old URL no longer works");
      },
      onError: (error) => {
        toast.error(`Failed to regenerate: ${error.message}`);
      },
    }),
  );

  const setRequireSignature = useMutation(
    trpc.webhook.setRequireSignature.mutationOptions({
      onSuccess: ({ requireSignature }) => {
        queryClient.invalidateQueries(getOptions);
        toast.success(
          requireSignature
            ? "Signature now required — unsigned requests will be rejected"
            : "Signature no longer required — the URL is the only protection",
        );
      },
      onError: (error) => {
        toast.error(`Could not change the setting: ${error.message}`);
      },
    }),
  );

  const url = data ? `${baseUrl}/api/webhooks/generic/${data.token}` : "";

  const copyToClipboard = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Send a POST request to this URL to run the workflow. The request
            body is available to downstream nodes as{" "}
            <code className="font-mono">{"{{webhook.body}}"}</code>.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">
            Save the workflow to generate your webhook URL.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-url">Webhook URL</Label>
              <div className="flex gap-2">
                <Input
                  id="webhook-url"
                  value={url}
                  readOnly
                  className="font-mono text-sm"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => copyToClipboard(url, "Webhook URL copied")}
                >
                  <CopyIcon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhook-secret">
                Signing secret
                {data.requireSignature ? "" : " (optional)"}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="webhook-secret"
                  value={data.secret}
                  readOnly
                  className="font-mono text-sm"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() =>
                    copyToClipboard(data.secret, "Signing secret copied")
                  }
                >
                  <CopyIcon className="size-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Send <code className="font-mono">X-Guideboard-Signature</code>{" "}
                as <code className="font-mono">sha256=&lt;HMAC&gt;</code> of the
                raw body using this secret.
              </p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="webhook-require-signature">
                  Require a signature
                </Label>
                {/* Says what turning it OFF actually costs, rather than just
                    naming the setting — the URL is the only credential left,
                    and URLs end up in logs and browser history. */}
                <p className="text-xs text-muted-foreground">
                  {data.requireSignature
                    ? "Unsigned requests are rejected. Turn this off only if the service calling this webhook cannot sign its requests."
                    : "Unsigned requests are accepted, so anyone who learns this URL can run the workflow. Turn this on once your sender is signing."}
                </p>
              </div>
              <Switch
                id="webhook-require-signature"
                checked={data.requireSignature}
                disabled={setRequireSignature.isPending}
                onCheckedChange={(requireSignature) =>
                  setRequireSignature.mutate({ workflowId, requireSignature })
                }
              />
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate({ workflowId })}
            >
              <RefreshCwIcon className="size-4" />
              Regenerate URL &amp; secret
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
