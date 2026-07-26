"use client";

import { type NodeProps, Position, useReactFlow } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import { memo, type ReactNode } from "react";
import { BaseHandle } from "@/components/react-flow/base-handle";
import { BaseNode, BaseNodeContent } from "@/components/react-flow/base-node";
import { CannotRunBadge } from "@/components/react-flow/cannot-run-badge";
import { NeedsConfigBadge } from "@/components/react-flow/needs-config-badge";
import { NodeFailureBadge } from "@/components/react-flow/node-failure-badge";
import {
  type NodeStatus,
  NodeStatusIndicator,
} from "@/components/react-flow/node-status-indicator";
import { WorkflowNode } from "@/components/workflow-node";
import { readNodeRef } from "@/lib/node-ref";

interface BaseTriggerNodeProps extends NodeProps {
  icon: LucideIcon | string;
  /** The trigger's type label (e.g. "Telegram Trigger"), shown until renamed. */
  name: string;
  description?: string;
  children?: ReactNode;
  status?: NodeStatus;
  onSettings?: () => void;
  onDoubleClick?: () => void;
}

export const BaseTriggerNode = memo(
  ({
    id,
    data,
    icon: Icon,
    name,
    description,
    children,
    status = "initial",
    onSettings,
    onDoubleClick,
  }: BaseTriggerNodeProps) => {
    // Delete through React Flow's own API so the removal flows through
    // `onNodesChange` (keeping editor.tsx's controlled state authoritative — a
    // store-only `setNodes` left it stale and a later drag resurrected the node)
    // while still updating the store the canvas, Save, and history observer read.
    // `deleteElements` removes the node's connected edges automatically.
    const { deleteElements } = useReactFlow();
    const handleDelete = () => {
      void deleteElements({ nodes: [{ id }] });
    };

    // Triggers get no auto-assigned ref (their output is keyed by a fixed name
    // like `telegram`, not a ref), but a user CAN rename one — that custom name
    // lands in `data.ref` via `<EditableNodeTitle>`. Show it once set, else the
    // type label.
    const caption = readNodeRef(data) ?? name;

    return (
      <WorkflowNode
        name={caption}
        onDelete={handleDelete}
        onSettings={onSettings}
      >
        <NodeStatusIndicator
          status={status}
          variant="border"
          className="rounded-[18px]"
        >
          <BaseNode
            status={status}
            onDoubleClick={onDoubleClick}
            className="relative size-20 rounded-2xl"
          >
            <NeedsConfigBadge nodeId={id} />
            <CannotRunBadge nodeId={id} />
            {status === "error" ? <NodeFailureBadge nodeId={id} /> : null}
            <BaseNodeContent className="size-full items-center justify-center p-0">
              {typeof Icon === "string" ? (
                <Image
                  src={Icon}
                  alt={name}
                  width={32}
                  height={32}
                  unoptimized
                />
              ) : (
                <Icon className="size-8 text-muted-foreground" />
              )}
              <BaseHandle
                id="source-1"
                type="source"
                position={Position.Right}
              />
            </BaseNodeContent>
          </BaseNode>
        </NodeStatusIndicator>
      </WorkflowNode>
    );
  },
);

BaseTriggerNode.displayName = "BaseTriggerNode";
