import { AppHeader } from "@/components/app-header";
import { DashboardRightRail } from "@/components/dashboard-right-rail";

const Layout = ({ children }: { children: React.ReactNode }) => {
  return (
    // Fixed-height column: the header stays put while only the content scrolls,
    // so it never drifts or rubber-bands on trackpad/overscroll.
    <div className="flex h-svh flex-col overflow-hidden">
      <AppHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1400px] gap-6 px-4 py-6 md:px-6">
          <main className="min-w-0 flex-1">{children}</main>
          <DashboardRightRail />
        </div>
      </div>
    </div>
  );
};

export default Layout;
