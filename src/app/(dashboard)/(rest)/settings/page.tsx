import { InstagramSettings } from "@/features/instagram-settings/components/instagram-settings";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

const Page = async () => {
  await requireAuth();

  return (
    <HydrateClient>
      <InstagramSettings />
    </HydrateClient>
  );
};

export default Page;
