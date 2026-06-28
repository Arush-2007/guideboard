"use client";

import { type NodeProps, Position, useReactFlow } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import { memo, type ReactNode } from "react";
import { BaseHandle } from "@/components/react-flow/base-handle";
import { BaseNode, BaseNodeContent } from "@/components/react-flow/base-node";
import {
  type NodeStatus,
  NodeStatusIndicator,
} from "@/components/react-flow/node-status-indicator";
import { WorkflowNode } from "@/components/workflow-node";

interface BaseExecutionNodeProps extends NodeProps {
  icon: LucideIcon | string;
  name: string;
  description?: string;
  children?: ReactNode;
  status?: NodeStatus;
  onSettings?: () => void;
  onDoubleClick?: () => void;
  /**
   * Source (output) handles for branching nodes. The handle `id` becomes the
   * stored `fromOutput` on any edge drawn from it, so it must match what the
   * executor emits via `routed(...)`. Defaults to a single `source-1` handle,
   * preserving the original single-output behavior for every non-branching node.
   */
  outputs?: { id: string; label?: string }[];
}

const DEFAULT_OUTPUTS = [{ id: "source-1" }];

export const BaseExecutionNode = memo(
  ({
    id,
    icon: Icon,
    name,
    description,
    children,
    status = "initial",
    onSettings,
    onDoubleClick,
    outputs = DEFAULT_OUTPUTS,
  }: BaseExecutionNodeProps) => {
    const { setNodes, setEdges } = useReactFlow();
    const handleDelete = () => {
      setNodes((currentNodes) => {
        const updatedNodes = currentNodes.filter((node) => node.id !== id);
        return updatedNodes;
      });

      setEdges((currentEdges) => {
        const updatedEdges = currentEdges.filter(
          (edge) => edge.source !== id && edge.target !== id,
        );
        return updatedEdges;
      });
    };

    return (
      <WorkflowNode name={name} onDelete={handleDelete} onSettings={onSettings}>
        <NodeStatusIndicator
          status={status}
          variant="border"
          className="rounded-2xl"
        >
          <BaseNode
            status={status}
            onDoubleClick={onDoubleClick}
            className="relative size-20 rounded-2xl"
          >
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
                id="target-1"
                type="target"
                position={Position.Left}
              />
              {outputs.map((output, index) => (
                <BaseHandle
                  key={output.id}
                  id={output.id}
                  type="source"
                  position={Position.Right}
                  style={
                    outputs.length > 1
                      ? {
                          top: `${((index + 1) / (outputs.length + 1)) * 100}%`,
                        }
                      : undefined
                  }
                >
                  {outputs.length > 1 && output.label ? (
                    <span className="absolute left-3 -translate-y-1/2 whitespace-nowrap text-[10px] text-muted-foreground">
                      {output.label}
                    </span>
                  ) : null}
                </BaseHandle>
              ))}
            </BaseNodeContent>
          </BaseNode>
        </NodeStatusIndicator>
      </WorkflowNode>
    );
  },
);

BaseExecutionNode.displayName = "BaseExecutionNode";
