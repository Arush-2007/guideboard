"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { PlugZapIcon } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { INTEGRATIONS } from "@/config/integrations";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/trpc/client";
import {
  useConnectedAccounts,
  useGoogleDependentWorkflowCount,
  useRefreshProfile,
} from "../hooks/use-profile";
import { describeScopes } from "../lib/oauth-scopes";

/**
 * The OAuth providers signed in to this account, what each one is allowed to
 * do, and how to sever it.
 *
 * Disconnecting Google is the consequential action on this page: the same grant
 * that signs the user in is what the Sheets/Gmail/Forms nodes run on. The
 * confirmation names how many workflows depend on it, and the server-side
 * mutation drops the mirrored `GoogleCredential` so those nodes fail with an
 * honest "not connected" rather than a stale-token error.
 */

/** Providers Better Auth manages, mapped to the shared brand registry. */
const PROVIDER_BRANDS = {
  google: INTEGRATIONS.google,
  github: INTEGRATIONS.github,
} as const;

const brandFor = (providerId: string) =>
  PROVIDER_BRANDS[providerId as keyof typeof PROVIDER_BRANDS] ?? {
    label: providerId,
    icon: null,
  };

/**
 * Re-runs the provider's consent screen. For Google this is also how a user
 * picks up newly-requested scopes — the same call the credentials page makes.
 */
const reconnect = (providerId: string) => {
  authClient.linkSocial({
    provider: providerId as "google" | "github",
    callbackURL: "/profile",
  });
};

export const ConnectedAccountsCard = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: accounts } = useConnectedAccounts();
  const { data: googleWorkflowCount } = useGoogleDependentWorkflowCount();
  const refreshProfile = useRefreshProfile();

  const [pendingDisconnect, setPendingDisconnect] = useState<string | null>(
    null,
  );

  const disconnect = useMutation(
    trpc.profile.disconnectAccount.mutationOptions({
      onSuccess: async (_data, variables) => {
        setPendingDisconnect(null);
        await refreshProfile();
        await queryClient.invalidateQueries(
          trpc.profile.googleDependentWorkflowCount.queryFilter(),
        );
        toast.success(`${brandFor(variables.providerId).label} disconnected`);
      },
      onError: (error) => {
        setPendingDisconnect(null);
        toast.error(error.message);
      },
    }),
  );

  const pendingBrand = pendingDisconnect ? brandFor(pendingDisconnect) : null;
  const pendingBreaksWorkflows =
    pendingDisconnect === "google" && googleWorkflowCount > 0;

  return (
    <>
      <Card className="rounded-3xl border border-primary/20 bg-card/90 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
              <PlugZapIcon className="size-5 text-primary" />
            </span>
            Connected accounts
          </CardTitle>
          <CardDescription>
            Sign-in providers linked to your account, and what they grant.
          </CardDescription>
        </CardHeader>

        <CardContent className="divide-y">
          {accounts.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No sign-in providers are connected. You sign in with your email
              address and password.
            </p>
          ) : null}

          {accounts.map((account) => {
            const brand = brandFor(account.providerId);
            const scopes = describeScopes(account.scopes);

            return (
              <div
                key={account.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {typeof brand.icon === "string" ? (
                    <Image
                      src={brand.icon}
                      alt=""
                      width={28}
                      height={28}
                      unoptimized
                      className="shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{brand.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Connected {format(account.createdAt, "d MMM yyyy")}
                    </p>
                    {scopes.length > 0 ? (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {scopes.map((scope) => (
                          <Badge
                            key={scope}
                            variant="outline"
                            className="text-[11px] font-normal text-muted-foreground"
                          >
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => reconnect(account.providerId)}
                  >
                    Reconnect
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setPendingDisconnect(account.providerId)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingDisconnect !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {pendingBrand?.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBreaksWorkflows ? (
                <>
                  <strong>
                    {googleWorkflowCount}{" "}
                    {googleWorkflowCount === 1 ? "workflow" : "workflows"}
                  </strong>{" "}
                  use Gmail, Google Sheets or Google Forms nodes. Those nodes
                  will stop running until you reconnect Google.
                </>
              ) : (
                <>
                  You&apos;ll no longer be able to sign in with{" "}
                  {pendingBrand?.label}. Make sure you can still get in another
                  way first.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>
              Keep connected
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                // Keep the dialog up while the mutation runs; its own handlers
                // close it, so a failure leaves the user where they were.
                event.preventDefault();
                if (pendingDisconnect) {
                  disconnect.mutate({ providerId: pendingDisconnect });
                }
              }}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
