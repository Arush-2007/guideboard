import { SparklesIcon } from "lucide-react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AppHeaderNotifications } from "@/components/app-header-notifications";

export const AppHeader = () => {
  return (
    <header className="shrink-0 z-30 border-b border-border/70 bg-background/90 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 w-full max-w-[1400px] items-center gap-3 px-4 md:px-6">
        <SidebarTrigger />
        <Link
          href="/workflows"
          className="hidden items-center gap-2 text-sm font-semibold tracking-tight sm:inline-flex"
        >
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <SparklesIcon className="size-4" />
          </span>
          Guideboard
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <AppHeaderNotifications />
        </div>
      </div>
    </header>
  );
};
