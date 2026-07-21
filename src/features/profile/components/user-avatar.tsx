"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { userInitials } from "../lib/user-initials";

/**
 * The one way a user's face is drawn — profile header and sidebar both use it,
 * so an uploaded avatar, an OAuth avatar and the initials fallback can't end up
 * looking like three different features.
 */

export const UserAvatar = ({
  name,
  email,
  image,
  className,
  fallbackClassName,
}: {
  name: string;
  email: string;
  image?: string | null;
  className?: string;
  fallbackClassName?: string;
}) => (
  <Avatar className={cn("size-8", className)}>
    {image ? <AvatarImage src={image} alt={name} /> : null}
    <AvatarFallback
      className={cn(
        "bg-primary/10 font-semibold text-primary",
        fallbackClassName,
      )}
    >
      {userInitials(name, email)}
    </AvatarFallback>
  </Avatar>
);
