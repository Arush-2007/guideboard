"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import type { RowMatchCondition } from "@/lib/row-match";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { GoogleSheetsActionSubmitValues } from "./dialog";

const GoogleSheetsActionDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.GoogleSheetsActionDialog),
);

import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.GOOGLE_SHEETS_ACTION);

type GoogleSheetsActionNodeData = {
  action?: "append_row" | "read_rows" | "find_rows";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  columnMappings?: Record<string, string>;
  requiredColumns?: string[];
  conditions?: RowMatchCondition[];
  selectedColumns?: string[];
  onMultipleMatches?: "first" | "error";
  discoveredFields?: { path: string; label: string }[];
};

type GoogleSheetsActionFlowNode = Node<GoogleSheetsActionNodeData>;

export const GoogleSheetsActionNode = memo(
  (props: NodeProps<GoogleSheetsActionFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: GoogleSheetsActionSubmitValues) => {
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
    const description = nodeData?.sheetName
      ? nodeData.action === "read_rows"
        ? `Read ${nodeData.sheetName}:${nodeData.range ?? ""}`
        : nodeData.action === "find_rows"
          ? `Find rows in ${nodeData.sheetName}`
          : `Append to ${nodeData.sheetName}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <GoogleSheetsActionDialog
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
  },
);

GoogleSheetsActionNode.displayName = "GoogleSheetsActionNode";
