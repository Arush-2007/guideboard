"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Filter } from "lucide-react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import { ConditionDialog, type ConditionFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { CONDITION_CHANNEL_NAME } from "@/inngest/channels/condition";
import { fetchConditionRealtimeToken } from "./actions";

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

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: CONDITION_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchConditionRealtimeToken,
  });

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
      <ConditionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        defaultValues={nodeData}
      />
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
