"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import { WhatsappActionDialog, WhatsappActionFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchWhatsappActionRealtimeToken } from "./actions";
import { WHATSAPP_ACTION_CHANNEL_NAME } from "@/inngest/channels/whatsapp-action";

type WhatsappActionNodeData = {
  recipientPhone?: string;
  message?: string;
};

type WhatsappActionNodeType = Node<WhatsappActionNodeData>;

export const WhatsappActionNode = memo((props: NodeProps<WhatsappActionNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: WHATSAPP_ACTION_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchWhatsappActionRealtimeToken,
  });

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: WhatsappActionFormValues) => {
    setNodes((nodes) => nodes.map((node) => {
      if (node.id === props.id) {
        return {
          ...node,
          data: {
            ...node.data,
            ...values,
          }
        }
      }
      return node;
    }))
  };

  const nodeData = props.data;
  const description = nodeData?.message
    ? `Send: ${nodeData.message.slice(0, 50)}...`
    : "Not configured";

  return (
    <>
      <WhatsappActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        defaultValues={nodeData}
      />
      <BaseExecutionNode
        {...props}
        id={props.id}
        icon="/logos/whatsapp.svg"
        name="WhatsApp"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  )
});

WhatsappActionNode.displayName = "WhatsappActionNode";
