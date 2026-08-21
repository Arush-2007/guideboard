import { LoginForm } from "@/features/auth/components/login-form";
import { requireUnauth } from "@/lib/auth-utils";
import { configuredSocialProviders } from "@/lib/social-providers";

const Page = async () => {
  await requireUnauth();

  return <LoginForm providers={configuredSocialProviders()} />;
};

export default Page;
