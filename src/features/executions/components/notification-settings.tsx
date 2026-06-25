"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTRPC } from "@/trpc/client";

export const NotificationSettings = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isPending } = useQuery(
    trpc.executions.getNotificationSettings.queryOptions(),
  );

  const update = useMutation(
    trpc.executions.updateNotificationSettings.mutationOptions({
      onSuccess: () => {
        toast.success("Notification settings saved");
        queryClient.invalidateQueries(
          trpc.executions.getNotificationSettings.queryOptions(),
        );
      },
      onError: (error) => {
        toast.error(`Failed to save: ${error.message}`);
      },
    }),
  );

  return (
    <Card className="rounded-3xl border border-primary/20 bg-card/90 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
            <BellIcon className="size-5 text-primary" />
          </span>
          Notifications
        </CardTitle>
        <CardDescription>
          Choose when Guideboard emails you about your workflows.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="notify-on-failure">
              Email me when a workflow fails
            </Label>
            <p className="text-sm text-muted-foreground">
              Get an email naming the failing node and error whenever a run
              fails.
            </p>
          </div>
          <Switch
            id="notify-on-failure"
            checked={data?.notifyOnFailure ?? true}
            disabled={isPending || update.isPending}
            onCheckedChange={(checked) =>
              update.mutate({ notifyOnFailure: checked })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
};
