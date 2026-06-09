import { AuthLayout } from "@/features/auth/components/auth-layout";
import { requireUnauth } from "@/lib/auth-utils";

// Mirror of the (dashboard) guard: authenticated users are bounced off auth pages
// here, so login/signup pages don't each have to remember requireUnauth().
const Layout = async ({ children }: { children: React.ReactNode }) => {
  await requireUnauth();

  return <AuthLayout>{children}</AuthLayout>;
};

export default Layout;
