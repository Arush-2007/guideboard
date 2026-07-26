"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { ExcelActionFormValues } from "./dialog";

const ExcelActionDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.ExcelActionDialog),
);

import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.EXCEL_ACTION);

type ExcelActionNodeData = {
  operation?: "append_row" | "upsert_by_key";
  workbookId?: string;
  worksheetName?: string;
  columnMappings?: Record<string, string>;
  keyColumn?: string;
  keyValue?: string;
  columnModes?: Record<string, "set" | "add">;
};

type ExcelActionFlowNode = Node<ExcelActionNodeData>;

export const ExcelActionNode = memo((props: NodeProps<ExcelActionFlowNode>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: ExcelActionFormValues) => {
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
  const description = nodeData?.worksheetName
    ? nodeData.operation === "upsert_by_key"
      ? `Upsert by ${nodeData.keyColumn || "key"} in ${nodeData.worksheetName}`
      : `Append to ${nodeData.worksheetName}`
    : "Not configured";

  return (
    <>
      {dialogOpen && (
        <ExcelActionDialog
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

ExcelActionNode.displayName = "ExcelActionNode";
