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

export const TelegramTriggerDialog = ({
  open,
  onOpenChange,
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
          <DialogTitle>Telegram Trigger Configuration</DialogTitle>
          <DialogDescription>
            Call{" "}
            <a
              href="https://core.telegram.org/bots/api#setwebhook"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              setWebhook
            </a>{" "}
            with this URL and the same{" "}
            <code className="text-xs bg-muted px-1 rounded">secret_token</code>{" "}
            as{" "}
            <code className="text-xs bg-muted px-1 rounded">
              TELEGRAM_WEBHOOK_SECRET
            </code>{" "}
            in your server environment.
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
            <h4 className="font-medium text-sm">Example (replace TOKEN)</h4>
            <p className="text-xs text-muted-foreground font-mono break-all">
              curl -X POST &quot;https://api.telegram.org/botTOKEN/setWebhook&quot;
              -d &quot;url=...&quot; -d
              &quot;secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET&quot;
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                copyToClipboard(
                  `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=${encodeURIComponent(webhookUrl)}" -d "secret_token=<same as TELEGRAM_WEBHOOK_SECRET>"`,
                  "Example curl copied",
                )
              }
            >
              <CopyIcon className="size-4 mr-2" />
              Copy example
            </Button>
          </div>

          <div className="rounded-lg bg-muted p-4 space-y-2">
            <h4 className="font-medium text-sm">Available variables</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                <code className="bg-background px-1 py-0.5 rounded">
                  {"{{telegram.text}}"}
                </code>{" "}
                — Message text
              </li>
              <li>
                <code className="bg-background px-1 py-0.5 rounded">
                  {"{{telegram.firstName}}"}
                </code>{" "}
                — Sender first name
              </li>
              <li>
                <code className="bg-background px-1 py-0.5 rounded">
                  {"{{telegram.chatId}}"}
                </code>{" "}
                — Chat id
              </li>
              <li>
                <code className="bg-background px-1 py-0.5 rounded">
                  {"{{json telegram.raw}}"}
                </code>{" "}
                — Full update payload
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
