import { NotificationSettings } from "@/features/executions/components/notification-settings";
import { InstagramSettings } from "@/features/instagram-settings/components/instagram-settings";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

const Page = async () => {
  await requireAuth();

  return (
    <HydrateClient>
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure your account, integrations, and notifications.
          </p>
        </div>

        <InstagramSettings />
        <NotificationSettings />
      </div>
    </HydrateClient>
  );
};

export default Page;
