"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { GOOGLE_SHEETS_ACTION_CHANNEL_NAME } from "@/inngest/channels/google-sheets-action";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import { fetchGoogleSheetsActionRealtimeToken } from "./actions";
import {
  GoogleSheetsActionDialog,
  type GoogleSheetsActionFormValues,
} from "./dialog";

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

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: GOOGLE_SHEETS_ACTION_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchGoogleSheetsActionRealtimeToken,
    });

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
        <GoogleSheetsActionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={nodeData}
          currentNodeId={props.id}
          workflowId={workflowId}
        />
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
