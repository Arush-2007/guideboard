"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BaseExecutionNode } from "../base-execution-node";
import { GmailActionDialog, GmailActionFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchGmailActionRealtimeToken } from "./actions";
import { GMAIL_ACTION_CHANNEL_NAME } from "@/inngest/channels/gmail-action";

type GmailActionNodeData = {
  to?: string;
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
  const description = nodeData?.subject
    ? `To: ${nodeData.to || "?"} — ${nodeData.subject.slice(0, 40)}${nodeData.subject.length > 40 ? "…" : ""}`
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
        name="Gmail Action"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  )
});

GmailActionNode.displayName = "GmailActionNode";
