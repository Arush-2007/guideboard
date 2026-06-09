import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireAuth } from "@/lib/auth-utils";

// Route-group baseline guard: every current and future page under (dashboard) is
// auth-protected by virtue of living here. Per-page requireAuth() calls remain as
// defense-in-depth and to access the session object (deduped via cache()).
const Layout = async ({ children }: { children: React.ReactNode }) => {
  await requireAuth();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-background">{children}</SidebarInset>
    </SidebarProvider>
  );
};

export default Layout;
