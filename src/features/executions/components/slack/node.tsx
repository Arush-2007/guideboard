"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { SlackFormValues } from "./dialog";

const SlackDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.SlackDialog),
);

import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.SLACK);

type SlackNodeData = {
  webhookUrls?: string[];
  /** Legacy single-webhook field, still read for backward compatibility. */
  webhookUrl?: string;
  content?: string;
};

type SlackNodeType = Node<SlackNodeData>;

export const SlackNode = memo((props: NodeProps<SlackNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: SlackFormValues) => {
    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id === props.id) {
          return {
            ...node,
            data: {
              ...node.data,
              ...values,
            },
          };
        }
        return node;
      }),
    );
  };

  const nodeData = props.data;
  const channelCount =
    (nodeData?.webhookUrls?.filter((u) => u.trim()).length ?? 0) ||
    (nodeData?.webhookUrl?.trim() ? 1 : 0);
  const description = nodeData?.content
    ? `${channelCount} channel${channelCount === 1 ? "" : "s"} — ${nodeData.content.slice(0, 36)}${nodeData.content.length > 36 ? "…" : ""}`
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <SlackDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={nodeData}
          currentNodeId={props.id}
          workflowId={workflowId}
        />
      )}
      <BaseExecutionNode
        {...props}
        id={props.id}
        icon={option.icon}
        name={option.label}
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

SlackNode.displayName = "SlackNode";
