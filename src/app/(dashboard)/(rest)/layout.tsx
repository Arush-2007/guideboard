import { AppHeader } from "@/components/app-header";

const Layout = ({ children }: { children: React.ReactNode }) => {
  return (
    // Fixed-height column: the header stays put while only the content scrolls,
    // so it never drifts or rubber-bands on trackpad/overscroll.
    <div className="flex h-svh flex-col overflow-hidden">
      <AppHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The layout owns the page gutter and nothing else; each page sets its
            own max-width (list pages are wider than form pages), so adding one
            here too would just fight them. */}
        <main className="w-full px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
};

export default Layout;
