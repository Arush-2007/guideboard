"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { WHATSAPP_ACTION_CHANNEL_NAME } from "@/inngest/channels/whatsapp-action";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import { fetchWhatsappActionRealtimeToken } from "./actions";
import { WhatsappActionDialog, type WhatsappActionFormValues } from "./dialog";

type WhatsappActionNodeData = {
  recipientPhones?: string[];
  /** Legacy single-recipient field, still read for backward compatibility. */
  recipientPhone?: string;
  message?: string;
};

type WhatsappActionNodeType = Node<WhatsappActionNodeData>;

export const WhatsappActionNode = memo(
  (props: NodeProps<WhatsappActionNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: WHATSAPP_ACTION_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchWhatsappActionRealtimeToken,
    });

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: WhatsappActionFormValues) => {
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
    const recipientCount =
      (nodeData?.recipientPhones?.filter((p) => p.trim()).length ?? 0) ||
      (nodeData?.recipientPhone?.trim() ? 1 : 0);
    const description = nodeData?.message
      ? `${recipientCount} recipient${recipientCount === 1 ? "" : "s"} — ${nodeData.message.slice(0, 36)}${nodeData.message.length > 36 ? "…" : ""}`
      : "Not configured";

    return (
      <>
        <WhatsappActionDialog
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
          icon="/logos/whatsapp.svg"
          name="Send WhatsApp"
          status={nodeStatus}
          description={description}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

WhatsappActionNode.displayName = "WhatsappActionNode";
