import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive hover:-translate-y-0.5 active:translate-y-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/95 hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_28%,transparent),0_10px_24px_color-mix(in_oklch,var(--primary)_28%,transparent)]",
        destructive:
          "bg-destructive text-white shadow-sm hover:bg-destructive/90 hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--destructive)_35%,transparent),0_10px_24px_color-mix(in_oklch,var(--destructive)_25%,transparent)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border border-border/80 bg-background shadow-xs hover:bg-accent/70 hover:text-accent-foreground hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_18%,transparent),0_8px_20px_color-mix(in_oklch,var(--primary)_16%,transparent)] dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/90 hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_18%,transparent),0_8px_20px_color-mix(in_oklch,var(--primary)_14%,transparent)]",
        ghost:
          "hover:bg-accent/70 hover:text-accent-foreground hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_18%,transparent)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-xl gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-xl px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
