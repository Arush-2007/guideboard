"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The red close cross shared by every overlay surface — dialogs, sheets, and the
 * node picker. Sheet is built on `@radix-ui/react-dialog` too, so this single
 * Close works inside either context.
 *
 * `className` supplies placement only. Where the cross sits depends on the box
 * it closes (a dialog's rounded corner, a sheet's inset, the picker's button),
 * so that stays at the call site while the look lives here — keeping the three
 * surfaces from drifting apart.
 */
export function OverlayCloseButton({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      className={cn(
        "ring-offset-background focus:ring-ring absolute rounded-xs bg-[#FF0000] text-white focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <XIcon />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  );
}
