"use client";

import dynamic from "next/dynamic";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Filter } from "lucide-react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BaseExecutionNode } from "../base-execution-node";
import type { ConditionFormValues } from "./dialog";
const ConditionDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.ConditionDialog),
);
import { useNodeStatus } from "../../hooks/use-node-status";

type ConditionNodeData = {
  field?: string;
  operator?: ConditionFormValues["operator"];
  value?: string;
  stopOnFail?: boolean;
};

type ConditionNodeType = Node<ConditionNodeData>;

export const ConditionNode = memo((props: NodeProps<ConditionNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: ConditionFormValues) => {
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
  const description = nodeData?.field
    ? `${nodeData.operator ?? "?"} → ${nodeData.field}`
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <ConditionDialog
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
        icon={Filter}
        name="Condition"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

ConditionNode.displayName = "ConditionNode";
