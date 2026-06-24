"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { XIcon } from "lucide-react";
import { nodeOptionByType } from "@/config/node-options";
import {
  STAGED_NODE_MIME,
  type StagedNode,
  stagedNodesAtom,
} from "../store/atoms";

// A single staged node, draggable onto the canvas. The drag payload is read by
// the editor's drop handler, which creates the real React Flow node and removes
// the staged entry.
const StagedChip = ({ node }: { node: StagedNode }) => {
  const setStaged = useSetAtom(stagedNodesAtom);
  const option = nodeOptionByType[node.type];
  const Icon = option?.icon;

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(STAGED_NODE_MIME, JSON.stringify(node));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleRemove = () => {
    setStaged((prev) => prev.filter((staged) => staged.id !== node.id));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag source, not a focusable control
    <div
      draggable
      onDragStart={handleDragStart}
      className="group flex shrink-0 cursor-grab items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 shadow-sm transition-colors hover:border-primary active:cursor-grabbing"
    >
      {typeof Icon === "string" ? (
        <img
          src={Icon}
          alt=""
          className="size-4 shrink-0 rounded-sm object-contain"
        />
      ) : Icon ? (
        <Icon className="size-4 shrink-0" />
      ) : null}
      <span className="whitespace-nowrap text-xs font-medium">
        {option?.label ?? node.type}
      </span>
      <button
        type="button"
        aria-label="Remove from staging"
        onClick={handleRemove}
        className="ml-1 rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
};

// The "organizing window": a horizontal tray along the bottom of the canvas,
// just left of the minimap, where nodes selected from the selector wait until
// the user drags them out onto the canvas. Styled to match the minimap (rounded,
// primary border, same height/inset) and reserves room on the right for it.
export const StagingTray = () => {
  const staged = useAtomValue(stagedNodesAtom);

  // Dropping back onto the tray is a no-op — swallow it so it doesn't bubble to
  // the canvas drop handler (which would otherwise place the node).
  const swallowDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone, not a focusable control
    <div
      onDrop={swallowDrop}
      onDragOver={(e) => e.preventDefault()}
      className="pointer-events-auto absolute bottom-[13.5px] left-[15px] right-[230px] z-20 flex h-[135px] flex-col gap-2 rounded-xl border-2 border-primary bg-card p-3 shadow-sm"
    >
      <span className="text-center text-xs font-medium text-muted-foreground">
        Drag the node to Canvas to use.
      </span>
      <div className="flex flex-1 flex-wrap content-start gap-2 overflow-y-auto pr-1">
        {staged.map((node) => (
          <StagedChip key={node.id} node={node} />
        ))}
      </div>
    </div>
  );
};
