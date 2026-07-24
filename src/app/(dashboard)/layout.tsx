import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireAuth } from "@/lib/auth-utils";

// Route-group baseline guard: every current and future page under (dashboard) is
// auth-protected by virtue of living here. Per-page requireAuth() calls remain as
// defense-in-depth and to access the session object (deduped via cache()).
const Layout = async ({ children }: { children: React.ReactNode }) => {
  const session = await requireAuth();

  return (
    <SidebarProvider>
      {/* Seed the sidebar with the server session so its footer renders the real
          user on the first paint — identical to what the client hook resolves to,
          which is what keeps SSR and hydration in lockstep (no id mismatch, no
          "Loading…" flash). The client session still overrides for freshness. */}
      <AppSidebar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
      />
      <SidebarInset className="bg-background">{children}</SidebarInset>
    </SidebarProvider>
  );
};

export default Layout;
