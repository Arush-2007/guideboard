"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { BaseExecutionNode } from "../base-execution-node";
import type { AiTextFormValues } from "./dialog";

const AiTextDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.AiTextDialog),
);

import { useNodeStatus } from "../../hooks/use-node-status";

const option = getNodeOption(NodeType.AI_TEXT);

type AiTextNodeData = {
  provider?: "openai" | "anthropic" | "gemini";
  credentialId?: string;
  systemPrompt?: string;
  prompt?: string;
};

type AiTextNodeType = Node<AiTextNodeData>;

export const AiTextNode = memo((props: NodeProps<AiTextNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: AiTextFormValues) => {
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
  const description = nodeData?.prompt
    ? `${nodeData.provider ?? "openai"}: ${nodeData.prompt.slice(0, 50)}...`
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <AiTextDialog
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

AiTextNode.displayName = "AiTextNode";
