"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type WideOverlayPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
};

/**
 * A wider dialog (`sm:max-w-3xl`, ~1.6× the standard config dialog) meant to be
 * layered ON TOP of a node's config window so roomy content — a column-mapping
 * grid, a filtered-read config, long form questions — gets full-width lines.
 * Scrolls internally (`max-h-[80vh]`) and inherits the built-in top-right close
 * button from `DialogContent`.
 *
 * Extracted from the Google Form trigger's "questions" overlay so every Sheets
 * config surface (append mapping, find_rows, color_rows) shares one panel.
 */
export function WideOverlayPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: WideOverlayPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
