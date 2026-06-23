"use client";

import dynamic from "next/dynamic";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BaseExecutionNode } from "../base-execution-node";
import type { OpenAiFormValues } from "./dialog";
const OpenAiDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.OpenAiDialog),
);
import { useNodeStatus } from "../../hooks/use-node-status";

type OpenAiNodeData = {
  variableName?: string;
  credentialId?: string;
  systemPrompt?: string;
  userPrompt?: string;
};

type OpenAiNodeType = Node<OpenAiNodeData>;

export const OpenAiNode = memo((props: NodeProps<OpenAiNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: OpenAiFormValues) => {
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
  const description = nodeData?.userPrompt
    ? `gpt-4: ${nodeData.userPrompt.slice(0, 50)}...`
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <OpenAiDialog
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
        icon="/logos/openai.svg"
        name="OpenAi"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

OpenAiNode.displayName = "OpenAiNode";
