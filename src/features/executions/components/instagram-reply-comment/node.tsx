"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BaseExecutionNode } from "../base-execution-node";
import { InstagramReplyDialog, type InstagramReplyFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchInstagramReplyRealtimeToken } from "./actions";
import { INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME } from "@/inngest/channels/instagram-reply-comment";

type InstagramReplyNodeData = {
  variableName?: string;
  replyMessage?: string;
};

type InstagramReplyNodeType = Node<InstagramReplyNodeData>;

export const InstagramReplyNode = memo(
  (props: NodeProps<InstagramReplyNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchInstagramReplyRealtimeToken,
    });

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: InstagramReplyFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id === props.id) {
            return { ...node, data: { ...node.data, ...values } };
          }
          return node;
        }),
      );
    };

    const nodeData = props.data;
    const description = nodeData?.replyMessage
      ? `Reply: ${nodeData.replyMessage.slice(0, 50)}...`
      : "Not configured";

    return (
      <>
        <InstagramReplyDialog
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
          icon="/logos/instagram.svg"
          name="Instagram Reply"
          status={nodeStatus}
          description={description}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

InstagramReplyNode.displayName = "InstagramReplyNode";
