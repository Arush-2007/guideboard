"use client";

import { formatDistanceToNow } from "date-fns";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import { useProfileSessions, useRefreshProfile } from "../hooks/use-profile";

/**
 * Every device holding a live session, and the means to end any of them. This
 * is the card that answers "is someone else in my account?", so the current
 * device is marked explicitly — otherwise the list is just rows of browsers and
 * the user can't tell which one not to revoke.
 */
export const SessionsCard = () => {
  const { data: sessions } = useProfileSessions();
  const refreshProfile = useRefreshProfile();
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const otherCount = sessions.filter((session) => !session.isCurrent).length;

  const revoke = async (token: string) => {
    setBusyToken(token);
    const { error } = await authClient.revokeSession({ token });
    setBusyToken(null);

    if (error) {
      toast.error(error.message ?? "Couldn't sign that device out");
      return;
    }
    await refreshProfile();
    toast.success("Device signed out");
  };

  const revokeOthers = async () => {
    setRevokingAll(true);
    const { error } = await authClient.revokeOtherSessions();
    setRevokingAll(false);

    if (error) {
      toast.error(error.message ?? "Couldn't sign the other devices out");
      return;
    }
    await refreshProfile();
    toast.success("Signed out everywhere else");
  };

  return (
    <Card className="rounded-3xl border border-primary/20 bg-card/90 shadow-sm">
      <CardHeader className="pb-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
                <MonitorSmartphoneIcon className="size-5 text-primary" />
              </span>
              Active sessions
            </CardTitle>
            <CardDescription>
              Devices currently signed in to your account.
            </CardDescription>
          </div>
          {otherCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={revokingAll}
              onClick={() => void revokeOthers()}
            >
              {revokingAll ? "Signing out…" : "Sign out everywhere else"}
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="divide-y">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{session.device.label}</p>
                {session.isCurrent ? (
                  <Badge
                    variant="secondary"
                    className="text-emerald-600 dark:text-emerald-400"
                  >
                    This device
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {session.ipAddress ? `${session.ipAddress} · ` : null}
                Last active{" "}
                {formatDistanceToNow(session.updatedAt, { addSuffix: true })}
              </p>
            </div>

            {session.isCurrent ? null : (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busyToken === session.token}
                onClick={() => void revoke(session.token)}
              >
                {busyToken === session.token ? "Signing out…" : "Sign out"}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
};
