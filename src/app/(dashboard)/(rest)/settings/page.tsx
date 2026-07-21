import { NotificationSettings } from "@/features/executions/components/notification-settings";
import { InstagramSettings } from "@/features/instagram-settings/components/instagram-settings";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

const Page = async () => {
  await requireAuth();

  return (
    <HydrateClient>
      {/* Same width as /profile — both are settings-style form pages. List
          pages are wider (max-w-5xl, via EntityContainer). The layout supplies
          the page padding, so none is set here. */}
      {/* No page title, matching /profile: each card names itself, and the
          sidebar already says which page you're on. */}
      <div className="mx-auto max-w-3xl space-y-6">
        <InstagramSettings />
        <NotificationSettings />
      </div>
    </HydrateClient>
  );
};

export default Page;
