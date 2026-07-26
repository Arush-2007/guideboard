"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The look of the red close cross shared by every overlay surface. Split from
 * the primitive below so a surface that ISN'T a Radix dialog can wear the same
 * cross instead of hand-rolling a fourth copy of it.
 *
 * `className` at each call site supplies placement only. Where the cross sits
 * depends on the box it closes (a dialog's rounded corner, a sheet's inset, the
 * picker's button), so that stays at the call site while the look lives here —
 * keeping the surfaces from drifting apart.
 */
const CROSS_CLASS =
  "ring-offset-background focus:ring-ring absolute rounded-xs bg-[#FF0000] text-white focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/**
 * The cross for dialogs, sheets, and the node picker — dismisses the surrounding
 * Radix dialog. Sheet is built on `@radix-ui/react-dialog` too, so this single
 * Close works inside either context.
 */
export function OverlayCloseButton({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close className={cn(CROSS_CLASS, className)} {...props}>
      <XIcon />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  );
}

/**
 * The same cross as a plain button, for a surface that has no Radix dialog to
 * close — the variable picker's popover, where one cross dismisses the popover
 * and the other steps back a panel. Pass `aria-label` when it does anything
 * other than close.
 */
export function OverlayCloseAction({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button type="button" className={cn(CROSS_CLASS, className)} {...props}>
      <XIcon />
      <span className="sr-only">Close</span>
    </button>
  );
}
