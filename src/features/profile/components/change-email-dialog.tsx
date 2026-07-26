"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/**
 * Requests an email change. Nothing changes on submit — Better Auth sends a
 * link and the address only moves once it's clicked. *Which* address receives
 * that link depends on whether the current one is verified, so the copy says so
 * rather than making the user guess where to look.
 */
export const ChangeEmailDialog = ({
  open,
  onOpenChange,
  currentEmail,
  currentEmailVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentEmail: string;
  currentEmailVerified: boolean;
}) => {
  const [newEmail, setNewEmail] = useState("");
  const [sending, setSending] = useState(false);

  const destination = currentEmailVerified ? currentEmail : "the new address";

  const submit = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (email === currentEmail.toLowerCase()) {
      toast.error("That's already your email address.");
      return;
    }

    setSending(true);
    const { error } = await authClient.changeEmail({
      newEmail: email,
      callbackURL: "/profile",
    });
    setSending(false);

    if (error) {
      toast.error(error.message ?? "Couldn't start the email change");
      return;
    }

    setNewEmail("");
    onOpenChange(false);
    toast.success(`Confirmation link sent to ${destination}`);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNewEmail("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change email address</DialogTitle>
          <DialogDescription>
            {currentEmailVerified
              ? `We'll email a confirmation link to ${currentEmail}. Your address changes only after you click it.`
              : "We'll email a verification link to the new address. Your address changes only after you click it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="new-email">New email address</Label>
          <Input
            id="new-email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={newEmail}
            disabled={sending}
            onChange={(event) => setNewEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={sending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={sending || !newEmail.trim()}
            onClick={() => void submit()}
          >
            {sending ? "Sending…" : "Send confirmation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
