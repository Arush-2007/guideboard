"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { AtsActionFormValues } from "./dialog";

const AtsActionDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.AtsActionDialog),
);

const option = getNodeOption(NodeType.ATS_ACTION);

type AtsActionNodeData = {
  provider?: "lever";
  environment?: "sandbox" | "production";
  name?: string;
};

type AtsActionNodeType = Node<AtsActionNodeData>;

export const AtsActionNode = memo((props: NodeProps<AtsActionNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: AtsActionFormValues) => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === props.id
          ? { ...node, data: { ...node.data, ...values } }
          : node,
      ),
    );
  };

  const nodeData = props.data;
  const description = nodeData?.name
    ? `Lever (${nodeData.environment ?? "sandbox"}) — create candidate`
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <AtsActionDialog
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

AtsActionNode.displayName = "AtsActionNode";
