import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A node type's registry icon, whichever kind it is.
 *
 * `NodeOption.icon` is a union: a Lucide component for utility nodes, a URL
 * string for a brand icon out of the integrations registry. Every surface that
 * renders a node by type (the node selector, the staging tray, the variable
 * picker's node list) needs the same branch, so it lives here once.
 *
 * `className` carries the size — the surfaces don't agree on one — and `alt` is
 * empty by default, for the common case where the icon sits next to the node's
 * name and would only repeat it to a screen reader.
 */
export function NodeTypeIcon({
  icon,
  alt = "",
  className,
}: {
  icon: LucideIcon | string | undefined;
  alt?: string;
  className?: string;
}) {
  if (!icon) return null;
  if (typeof icon === "string") {
    return (
      <img
        src={icon}
        alt={alt}
        className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
      />
    );
  }
  const Icon = icon;
  return <Icon className={cn("size-4 shrink-0", className)} />;
}
