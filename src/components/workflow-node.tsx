"use client";

import { NodeToolbar, Position } from "@xyflow/react";
import { SettingsIcon, TrashIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NODE_LABEL_MAX_WIDTH } from "@/features/editor/lib/canvas-metrics";
import { Button } from "./ui/button";

interface WorkflowNodeProps {
  children: ReactNode;
  showToolbar?: boolean;
  onDelete?: () => void;
  onSettings?: () => void;
  name?: string;
}

export function WorkflowNode({
  children,
  showToolbar = true,
  onDelete,
  onSettings,
  name,
}: WorkflowNodeProps) {
  return (
    <>
      {showToolbar && (
        <NodeToolbar>
          <Button size="sm" variant="ghost" onClick={onSettings}>
            <SettingsIcon className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <TrashIcon className="size-4" />
          </Button>
        </NodeToolbar>
      )}
      {children}
      {/* `maxWidth` comes from the shared canvas metric rather than a Tailwind
          literal: the auto-layout reserves exactly this much horizontal room
          per column, and a hardcoded copy here could drift out of sync and put
          names back on top of each other. */}
      {name && (
        <NodeToolbar
          position={Position.Bottom}
          isVisible
          className="text-center"
          style={{ maxWidth: NODE_LABEL_MAX_WIDTH }}
        >
          <p className="text-[0.6rem] font-medium leading-tight">{name}</p>
        </NodeToolbar>
      )}
    </>
  );
}
