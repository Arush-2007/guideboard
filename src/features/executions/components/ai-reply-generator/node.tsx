"use client";

import dynamic from "next/dynamic";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Sparkles } from "lucide-react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import type { AiReplyGeneratorFormValues } from "./dialog";
const AiReplyGeneratorDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.AiReplyGeneratorDialog),
);
import { useNodeStatus } from "../../hooks/use-node-status";

type AiReplyGeneratorNodeData = {
  variableName?: string;
  xaiCredentialId?: string;
  geminiCredentialId?: string;
  openaiCredentialId?: string;
  groqCredentialId?: string;
  postDescription?: string;
};

type AiReplyGeneratorNodeType = Node<AiReplyGeneratorNodeData>;

export const AiReplyGeneratorNode = memo(
  (props: NodeProps<AiReplyGeneratorNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus(props.id);

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
        {dialogOpen && (
          <AiReplyGeneratorDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={handleSubmit}
            defaultValues={nodeData}
          />
        )}
        <BaseExecutionNode
          {...props}
          id={props.id}
          icon={Sparkles}
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
