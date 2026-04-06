"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import {
  TelegramActionDialog,
  type TelegramActionFormValues,
} from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchTelegramActionRealtimeToken } from "./actions";
import { TELEGRAM_ACTION_CHANNEL_NAME } from "@/inngest/channels/telegram-action";

type TelegramActionNodeData = {
  credentialId?: string;
  chatId?: string;
  message?: string;
};

type TelegramActionFlowNode = Node<TelegramActionNodeData>;

export const TelegramActionNode = memo((props: NodeProps<TelegramActionFlowNode>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: TELEGRAM_ACTION_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchTelegramActionRealtimeToken,
  });

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: TelegramActionFormValues) => {
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
  const description = nodeData?.message
    ? `Send: ${nodeData.message.slice(0, 50)}${nodeData.message.length > 50 ? "…" : ""}`
    : "Not configured";

  return (
    <>
      <TelegramActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        defaultValues={nodeData}
      />
      <BaseExecutionNode
        {...props}
        id={props.id}
        icon="/logos/telegram.svg"
        name="Telegram"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

TelegramActionNode.displayName = "TelegramActionNode";
