"use client";

import { TriangleAlert } from "lucide-react";

/**
 * The canvas's one "this node needs your attention" mark: a filled warning
 * triangle (⚠) parked at the node's top-right corner.
 *
 * An amber fill with a dark outline is the conventional warning colorway and
 * reads cleanly on both the node (bg-card) and the canvas in either theme; a
 * drop shadow lifts it off the node. No enclosing circle — so nothing can look
 * off-center inside it.
 *
 * Owned here rather than by each badge because the geometry is a set of tuned
 * magic numbers (the size, the stroke width, the shadow, the corner offsets),
 * and three copies of it meant three edits to nudge the canvas — or a canvas
 * that drifted out of alignment when only one was touched. The badges above it
 * decide WHEN to show a warning and what it says; this decides what one looks
 * like.
 *
 * Because they all share a corner, only one may render at a time — see the
 * mutual-exclusion notes on each badge.
 */
export const CornerWarningBadge = ({ label }: { label: string }) => (
  <span
    role="img"
    title={label}
    aria-label={label}
    className="absolute -right-2 -top-2 z-10 drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.35)]"
  >
    <TriangleAlert
      className="size-[18px] fill-amber-400 text-amber-950"
      strokeWidth={2.25}
    />
  </span>
);
