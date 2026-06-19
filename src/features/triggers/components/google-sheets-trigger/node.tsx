"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";
import {
  GoogleSheetsTriggerDialog,
  type GoogleSheetsTriggerFormValues,
} from "./dialog";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { fetchGoogleSheetsTriggerRealtimeToken } from "./actions";
import { GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/google-sheets-trigger";

type GoogleSheetsTriggerNodeData = {
  spreadsheetId?: string;
  sheetName?: string;
};

type GoogleSheetsTriggerFlowNode = Node<GoogleSheetsTriggerNodeData>;

export const GoogleSheetsTriggerNode = memo(
  (props: NodeProps<GoogleSheetsTriggerFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchGoogleSheetsTriggerRealtimeToken,
    });

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: GoogleSheetsTriggerFormValues) => {
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

    const description = props.data?.sheetName
      ? `Watching ${props.data.sheetName}`
      : "Not configured";

    return (
      <>
        <GoogleSheetsTriggerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={props.data}
        />
        <BaseTriggerNode
          {...props}
          icon="/logos/google-sheets.svg"
          name="Google Sheets Trigger"
          description={description}
          status={nodeStatus}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

GoogleSheetsTriggerNode.displayName = "GoogleSheetsTriggerNode";
