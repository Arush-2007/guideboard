"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import {
  AiReplyGeneratorDialog,
  type AiReplyGeneratorFormValues,
} from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchAiReplyGeneratorRealtimeToken } from "./actions";
import { AI_REPLY_GENERATOR_CHANNEL_NAME } from "@/inngest/channels/ai-reply-generator";

type AiReplyGeneratorNodeData = {
  variableName?: string;
  xaiCredentialId?: string;
  geminiCredentialId?: string;
  openaiCredentialId?: string;
  postDescription?: string;
};

type AiReplyGeneratorNodeType = Node<AiReplyGeneratorNodeData>;

export const AiReplyGeneratorNode = memo(
  (props: NodeProps<AiReplyGeneratorNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: AI_REPLY_GENERATOR_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchAiReplyGeneratorRealtimeToken,
    });

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: AiReplyGeneratorFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id === props.id) {
            return { ...node, data: { ...node.data, ...values } };
          }
          return node;
        }),
      );
    };

    const nodeData = props.data;
    const description = nodeData?.variableName
      ? `AI reply → ${nodeData.variableName}.text`
      : "Not configured";

    return (
      <>
        <AiReplyGeneratorDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={nodeData}
        />
        <BaseExecutionNode
          {...props}
          id={props.id}
          icon="/logos/xai.svg"
          name="AI Reply Generator"
          status={nodeStatus}
          description={description}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

AiReplyGeneratorNode.displayName = "AiReplyGeneratorNode";
