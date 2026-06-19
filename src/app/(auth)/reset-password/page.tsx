import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";

const Page = async ({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) => {
  const { token, error } = await searchParams;

  return <ResetPasswordForm token={token} error={error} />;
};

export default Page;
