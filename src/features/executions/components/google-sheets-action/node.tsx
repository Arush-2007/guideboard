"use client";

import dynamic from "next/dynamic";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { GoogleSheetsActionFormValues } from "./dialog";
const GoogleSheetsActionDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.GoogleSheetsActionDialog),
);

type GoogleSheetsActionNodeData = {
  action?: "append_row" | "read_rows";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  columnMappings?: Record<string, string>;
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

    const handleSubmit = (values: GoogleSheetsActionFormValues) => {
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
          icon="/logos/google-sheets.svg"
          name="Google Sheets"
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
