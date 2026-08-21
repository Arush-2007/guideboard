import { RegisterForm } from "@/features/auth/components/register-form";
import { requireUnauth } from "@/lib/auth-utils";
import { configuredSocialProviders } from "@/lib/social-providers";

const Page = async () => {
  await requireUnauth();

  return <RegisterForm providers={configuredSocialProviders()} />;
};

export default Page;
