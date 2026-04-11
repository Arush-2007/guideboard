"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BrainCircuit } from "lucide-react";
import { BaseExecutionNode } from "../base-execution-node";
import { AiTextDialog, type AiTextFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchAiTextRealtimeToken } from "./actions";
import { AI_TEXT_CHANNEL_NAME } from "@/inngest/channels/ai-text";

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

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: AI_TEXT_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchAiTextRealtimeToken,
  });

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
      <AiTextDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        defaultValues={nodeData}
        currentNodeId={props.id}
        workflowId={workflowId}
      />
      <BaseExecutionNode
        {...props}
        id={props.id}
        icon={BrainCircuit}
        name="AI"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

AiTextNode.displayName = "AiTextNode";
