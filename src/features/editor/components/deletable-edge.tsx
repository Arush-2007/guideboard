"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useReactFlow,
} from "@xyflow/react";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The canvas edge. Renders the same bezier + arrow marker as React Flow's
 * default edge, but adds the two things the default lacks: a comfortable hit
 * area and a visible delete control, so a connection can be removed directly
 * instead of forcing the user to delete a whole node.
 *
 * Deletion goes through `deleteElements`, which routes a `remove` change into
 * `editor.tsx`'s controlled `edges` state (the same path the Delete key already
 * uses). That means it composes for free with dirty-tracking, undo/redo, and
 * save — none of which need to know this edge exists. We deliberately do NOT
 * call `useReactFlow().setEdges` here: a store-only write is clobbered by the
 * controlled-prop re-sync (the pitfall documented in `use-editor-shortcuts.ts`).
 *
 * The × button lives in an `EdgeLabelRenderer` portal — a separate DOM tree from
 * the SVG edge — so `group-hover` cannot bridge the wire and the button. Hover
 * is tracked in JS instead, with a short close delay so moving the pointer from
 * the wire onto the button doesn't make it flicker out from under the cursor.
 */
export const DeletableEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
}: EdgeProps) => {
  const { deleteElements } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const active = hovered || Boolean(selected);

  const open = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHovered(true);
  };
  const close = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), 80);
  };

  // Clicking × deletes this edge, which unmounts this component — with a close
  // timer very likely still pending, since the pointer was on it. Drop the timer
  // on unmount so it can't fire (and hold this closure alive) after the fact.
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={0}
        style={{
          strokeWidth: active ? 2.5 : 1.5,
          stroke: active
            ? "var(--primary)"
            : "color-mix(in oklch, var(--primary) 45%, var(--muted-foreground))",
        }}
      />
      {/* Wide transparent hit area — the real click/hover target for the ~1px
          visible wire. Clicks bubble up to React Flow's edge group so a click
          still selects the edge (and Delete still works on it). */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: transparent hover/hit target for a wire; edges are also removable via the Delete key and the button */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: "pointer" }}
        onMouseEnter={open}
        onMouseLeave={close}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label="Delete connection"
          className={`nodrag nopan absolute flex size-5 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow-sm transition-opacity hover:border-destructive hover:bg-destructive hover:text-destructive-foreground ${
            active ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: active ? "all" : "none",
          }}
          onMouseEnter={open}
          onMouseLeave={close}
          onClick={(event) => {
            event.stopPropagation();
            void deleteElements({ edges: [{ id }] });
          }}
        >
          <XIcon className="size-3" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
};
