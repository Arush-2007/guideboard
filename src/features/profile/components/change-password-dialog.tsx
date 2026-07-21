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

/** Better Auth's default floor; stated up front rather than after a rejection. */
const MIN_PASSWORD_LENGTH = 8;

export const ChangePasswordDialog = ({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Awaited before the success toast, so the session list is already fresh. */
  onChanged: () => Promise<unknown>;
}) => {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const submit = async () => {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(
        `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("The two new passwords don't match.");
      return;
    }

    setSaving(true);
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      // Anyone who knew the old password is signed out everywhere else. This is
      // the whole point of changing a password you think has leaked.
      revokeOtherSessions: true,
    });
    setSaving(false);

    if (error) {
      toast.error(error.message ?? "Couldn't change your password");
      return;
    }

    reset();
    onOpenChange(false);
    await onChanged();
    toast.success("Password changed — other devices have been signed out");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            You&apos;ll stay signed in here. Every other device will be signed
            out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              disabled={saving}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              disabled={saving}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              disabled={saving}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={saving || !currentPassword || !newPassword}
            onClick={() => void submit()}
          >
            {saving ? "Changing…" : "Change password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
