"use client";

import { AtSignIcon, KeyRoundIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import { useProfile, useRefreshProfile } from "../hooks/use-profile";
import { ChangeEmailDialog } from "./change-email-dialog";
import { ChangePasswordDialog } from "./change-password-dialog";

/** One label / value / action row, so the three rows can't drift apart. */
const Row = ({
  label,
  description,
  children,
}: {
  label: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0 space-y-0.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="text-sm text-muted-foreground">{description}</div>
    </div>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>
);

export const AccountCard = () => {
  const { data: profile } = useProfile();
  const refreshProfile = useRefreshProfile();

  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [sendingSetup, setSendingSetup] = useState(false);

  /**
   * OAuth-only accounts have no password to compare against, so there's no safe
   * in-app way to set one — anyone holding a hijacked session could do it. The
   * existing reset flow proves control of the inbox first, so we reuse that
   * rather than inventing a second path.
   */
  const sendPasswordSetup = async () => {
    setSendingSetup(true);
    const { error } = await authClient.requestPasswordReset({
      email: profile.email,
      redirectTo: "/reset-password",
    });
    setSendingSetup(false);

    if (error) {
      toast.error(error.message ?? "Couldn't send the email");
      return;
    }
    toast.success(`Check ${profile.email} for a link to set your password`);
  };

  return (
    <>
      <Card className="rounded-3xl border border-primary/20 bg-card/90 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
              <UserRoundIcon className="size-5 text-primary" />
            </span>
            Account
          </CardTitle>
          <CardDescription>
            How you sign in, and the identifier support will ask for.
          </CardDescription>
        </CardHeader>

        <CardContent className="divide-y">
          <Row
            label="Email address"
            description={
              <span className="flex items-center gap-1.5">
                <AtSignIcon className="size-3.5 shrink-0" />
                <span className="truncate">{profile.email}</span>
              </span>
            }
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEmailOpen(true)}
            >
              Change
            </Button>
          </Row>

          <Row
            label="Password"
            description={
              profile.hasPassword
                ? "Changing it signs out every other device."
                : "You sign in with a connected account. Add a password as a backup."
            }
          >
            {profile.hasPassword ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPasswordOpen(true)}
              >
                <KeyRoundIcon className="size-4" />
                Change
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={sendingSetup}
                onClick={() => void sendPasswordSetup()}
              >
                <KeyRoundIcon className="size-4" />
                {sendingSetup ? "Sending…" : "Set a password"}
              </Button>
            )}
          </Row>

          <Row
            label="User ID"
            description={
              <span className="block max-w-full">
                Quote this when you contact support — it identifies your account
                without exposing anything personal.
              </span>
            }
          >
            <code className="max-w-[14rem] truncate rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs">
              {profile.id}
            </code>
            <CopyButton
              value={profile.id}
              label="Copy user ID"
              successMessage="User ID copied"
            />
          </Row>
        </CardContent>
      </Card>

      <ChangeEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        currentEmail={profile.email}
        currentEmailVerified={profile.emailVerified}
      />
      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        onChanged={refreshProfile}
      />
    </>
  );
};
