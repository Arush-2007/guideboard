"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { GMAIL_ACTION_CHANNEL_NAME } from "@/inngest/channels/gmail-action";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import { fetchGmailActionRealtimeToken } from "./actions";
import { GmailActionDialog, type GmailActionFormValues } from "./dialog";

type GmailActionNodeData = {
  to?: string | string[];
  subject?: string;
  body?: string;
};

type GmailActionNodeType = Node<GmailActionNodeData>;

export const GmailActionNode = memo((props: NodeProps<GmailActionNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: GMAIL_ACTION_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchGmailActionRealtimeToken,
  });

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: GmailActionFormValues) => {
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
  const recipientCount = Array.isArray(nodeData?.to)
    ? nodeData.to.filter((r) => r.trim()).length
    : nodeData?.to?.trim()
      ? 1
      : 0;
  const description = nodeData?.subject
    ? `${recipientCount} recipient${recipientCount === 1 ? "" : "s"} — ${nodeData.subject.slice(0, 36)}${nodeData.subject.length > 36 ? "…" : ""}`
    : "Not configured";

  return (
    <>
      <GmailActionDialog
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
        icon="/logos/gmail.svg"
        name="Send Email"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

GmailActionNode.displayName = "GmailActionNode";
