"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type Props = {
  /** One-line summary of active options, shown next to the label when collapsed. */
  summary?: string | null;
  children: ReactNode;
};

/**
 * The shared "Restraints" disclosure — a collapsible whose trigger is a chevron
 * plus the word "Restraints" and, when collapsed, a summary of what's active.
 * Owns only the chrome; callers supply the actual controls as children. Keeping
 * this in one place is why every node that has "Restraints" looks identical
 * (matching options, the Sheets trigger's watched-columns picker, …).
 */
export function RestraintsSection({ summary, children }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-sm py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium">Restraints</span>
        {!open && summary ? (
          <span className="truncate text-muted-foreground/70">→ {summary}</span>
        ) : null}
      </CollapsibleTrigger>

      <CollapsibleContent className="pt-1.5">
        <div className="space-y-2.5 rounded-md border bg-muted/30 p-3">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
