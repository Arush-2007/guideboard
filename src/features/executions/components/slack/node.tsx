"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { SLACK_CHANNEL_NAME } from "@/inngest/channels/slack";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import { fetchSlackRealtimeToken } from "./actions";
import { SlackDialog, type SlackFormValues } from "./dialog";

type SlackNodeData = {
  webhookUrls?: string[];
  /** Legacy single-webhook field, still read for backward compatibility. */
  webhookUrl?: string;
  content?: string;
};

type SlackNodeType = Node<SlackNodeData>;

export const SlackNode = memo((props: NodeProps<SlackNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: SLACK_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchSlackRealtimeToken,
  });

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: SlackFormValues) => {
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
  const channelCount =
    (nodeData?.webhookUrls?.filter((u) => u.trim()).length ?? 0) ||
    (nodeData?.webhookUrl?.trim() ? 1 : 0);
  const description = nodeData?.content
    ? `${channelCount} channel${channelCount === 1 ? "" : "s"} — ${nodeData.content.slice(0, 36)}${nodeData.content.length > 36 ? "…" : ""}`
    : "Not configured";

  return (
    <>
      <SlackDialog
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
        icon="/logos/slack.svg"
        name="Send to Slack"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

SlackNode.displayName = "SlackNode";
