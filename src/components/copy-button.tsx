"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Copies a string, then confirms it by swapping to a tick for a moment.
 *
 * Several trigger dialogs hand-roll this same clipboard-plus-toast dance; new
 * surfaces should use this instead of adding another copy, and those dialogs
 * are worth folding in next time one of them is touched.
 */
const CONFIRM_MS = 1500;

export const CopyButton = ({
  value,
  label = "Copy",
  successMessage = "Copied to clipboard",
  className,
  variant = "ghost",
  size = "icon",
}: {
  value: string;
  /** Accessible name; also the visible text for non-icon sizes. */
  label?: string;
  successMessage?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear on unmount so the timeout can't fire into a dead component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
      toast.success(successMessage);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  };

  const Icon = copied ? CheckIcon : CopyIcon;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label}
      className={cn(size === "icon" && "size-8", className)}
      onClick={() => void copy()}
    >
      <Icon className={cn("size-4", copied && "text-emerald-500")} />
      {size !== "icon" ? label : null}
    </Button>
  );
};
