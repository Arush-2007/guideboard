"use client";

import { CopyIcon } from "lucide-react";
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentNodeId: string;
}

export const TelegramTriggerDialog = ({
  open,
  onOpenChange,
  currentNodeId,
}: Props) => {
  const params = useParams();
  const workflowId = params.workflowId as string;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/webhooks/telegram?workflowId=${workflowId}`;

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
            When someone messages your Telegram bot, this workflow fires. Make
            sure your bot token credential is added under Credentials first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="telegram-webhook-url">Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                id="telegram-webhook-url"
                value={webhookUrl}
                readOnly
                className="font-mono text-sm"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() =>
                  copyToClipboard(webhookUrl, "Webhook URL copied")
                }
              >
                <CopyIcon className="size-4" />
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-muted p-4 space-y-2">
            <h4 className="font-medium text-sm">
              How to register this webhook with Telegram:
            </h4>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Open Telegram and message @BotFather</li>
              <li>Send /mybots and select your bot</li>
              <li>Go to Bot Settings → API Token to get your token</li>
              <li>Run this command replacing TOKEN and SECRET:</li>
            </ol>
            <p className="text-xs text-muted-foreground font-mono break-all">
              curl -X POST https://api.telegram.org/bot{"{TOKEN}"}/setWebhook -d
              url={webhookUrl} -d secret_token={"{TELEGRAM_WEBHOOK_SECRET}"}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
