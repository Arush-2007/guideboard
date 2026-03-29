import { BellIcon, SearchIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";

export const AppHeader = () => {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/90 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
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
        <div className="relative ml-1 hidden w-full max-w-sm md:block">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            readOnly
            aria-label="Search"
            className="h-10 rounded-full border-border/80 bg-card/80 pl-9"
            placeholder="Search workflows, credentials, executions..."
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded-full border border-primary/20 bg-primary/10 px-3.5 py-1.5 text-xs font-semibold text-primary sm:inline-flex">
            Workspace
          </span>
          <ThemeToggle />
          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-full border border-border/80 bg-card text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent hover:text-foreground hover:shadow-sm"
            aria-label="Notifications"
          >
            <BellIcon className="size-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
