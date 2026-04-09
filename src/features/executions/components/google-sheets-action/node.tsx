"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import {
  GoogleSheetsActionDialog,
  type GoogleSheetsActionFormValues,
} from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchGoogleSheetsActionRealtimeToken } from "./actions";
import { GOOGLE_SHEETS_ACTION_CHANNEL_NAME } from "@/inngest/channels/google-sheets-action";

type GoogleSheetsActionNodeData = {
  action?: "append_row" | "read_rows";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
};

type GoogleSheetsActionFlowNode = Node<GoogleSheetsActionNodeData>;

export const GoogleSheetsActionNode = memo(
  (props: NodeProps<GoogleSheetsActionFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

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
      ? `${nodeData.action === "read_rows" ? "Read" : "Append"} ${nodeData.sheetName}:${nodeData.range ?? "A1:D1"}`
      : "Not configured";

    return (
      <>
        <GoogleSheetsActionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={nodeData}
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
