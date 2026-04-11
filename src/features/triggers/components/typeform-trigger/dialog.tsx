"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const TypeformTriggerDialog = ({
  open,
  onOpenChange,
}: Props) => {
  const params = useParams();
  const workflowId = params.workflowId as string;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/webhooks/typeform?workflowId=${workflowId}`;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied to clipboard");
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Typeform Trigger Configuration</DialogTitle>
          <DialogDescription>
            Add this URL as a webhook destination in your Typeform form
            settings. Use the same secret in Typeform and in{" "}
            <code className="text-xs bg-muted px-1 rounded">
              TYPEFORM_WEBHOOK_SECRET
            </code>{" "}
            in your app environment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="typeform-webhook-url">Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                id="typeform-webhook-url"
                value={webhookUrl}
                readOnly
                className="font-mono text-sm"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={copyToClipboard}
              >
                <CopyIcon className="size-4" />
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-muted p-4 space-y-2">
            <h4 className="font-medium text-sm">Setup instructions</h4>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Open your form in Typeform</li>
              <li>Go to Connect → Webhooks</li>
              <li>Paste the webhook URL above</li>
              <li>Set the webhook secret to match TYPEFORM_WEBHOOK_SECRET</li>
              <li>Save and toggle the webhook on</li>
            </ol>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
};
