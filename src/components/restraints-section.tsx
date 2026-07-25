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
        <span className="shrink-0 font-medium">Restraints</span>
        {!open && summary ? (
          // `min-w-0` is what lets `truncate` actually clip: without it a flex
          // item keeps its full content width (white-space:nowrap), so a long
          // summary — e.g. many ignored/watched columns — pushes the row past the
          // dialog and the whole dialog scrolls horizontally.
          <span className="min-w-0 truncate text-muted-foreground/70">
            → {summary}
          </span>
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
