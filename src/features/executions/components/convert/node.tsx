"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { Replace } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { type ConversionKind, conversionOption } from "@/lib/conversions";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { ConvertFormValues } from "./dialog";

const ConvertDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.ConvertDialog),
);

type ConvertNodeData = {
  conversion?: ConversionKind;
  input?: string;
};

type ConvertNodeType = Node<ConvertNodeData>;

export const ConvertNode = memo((props: NodeProps<ConvertNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: ConvertFormValues) => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === props.id
          ? { ...node, data: { ...node.data, ...values } }
          : node,
      ),
    );
  };

  const nodeData = props.data;
  const description = nodeData?.input
    ? conversionOption(nodeData.conversion ?? "pdf_to_text").label
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <ConvertDialog
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
        icon={Replace}
        name="Convert"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

ConvertNode.displayName = "ConvertNode";
