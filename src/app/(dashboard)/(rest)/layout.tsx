import { AppHeader } from "@/components/app-header";
import { DashboardRightRail } from "@/components/dashboard-right-rail";

const Layout = ({ children }: { children: React.ReactNode; }) => {
  return (
    <div className="min-h-svh">
      <AppHeader />
      <div className="mx-auto flex w-full max-w-[1400px] gap-6 px-4 py-6 md:px-6">
        <main className="min-w-0 flex-1">{children}</main>
        <DashboardRightRail />
      </div>
    </div>
  );
};

export default Layout;
