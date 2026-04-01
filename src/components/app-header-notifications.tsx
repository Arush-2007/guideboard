"use client";

import { BellIcon } from "lucide-react";
import Link from "next/link";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotifications } from "@/hooks/use-notifications";

export const AppHeaderNotifications = () => {
  const { failures, unseenCount, markSeen } = useNotifications();

  return (
    <Popover onOpenChange={(open) => { if (open) markSeen(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative inline-flex size-10 items-center justify-center rounded-full border border-border/80 bg-card text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent hover:text-foreground hover:shadow-sm"
          aria-label="Notifications"
        >
          <BellIcon className="size-4" />
          {unseenCount > 0 && (
            <span className="absolute right-1 top-1 size-2 rounded-full bg-destructive" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b p-3">
          <p className="text-sm font-medium">Recent failures</p>
        </div>
        {failures.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No failed executions
          </div>
        ) : (
          <div className="divide-y">
            {failures.map((f) => (
              <Link
                key={f.id}
                href={`/executions/${f.id}`}
                className="flex flex-col gap-1 p-3 transition-colors hover:bg-muted"
              >
                <span className="text-sm font-medium">{f.workflow.name}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(f.startedAt).toLocaleString()}
                </span>
                {f.error && (
                  <span className="truncate text-xs text-destructive">
                    {f.error}
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
