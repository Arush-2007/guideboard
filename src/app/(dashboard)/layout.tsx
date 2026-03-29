import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

const Layout = ({ children }: { children: React.ReactNode; }) => {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-background">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
};

export default Layout;
