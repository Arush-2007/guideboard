"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseExecutionNode } from "../base-execution-node";
import { YoutubeReplyDialog, type YoutubeReplyFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchYoutubeReplyRealtimeToken } from "./actions";
import { YOUTUBE_REPLY_COMMENT_CHANNEL_NAME } from "@/inngest/channels/youtube-reply-comment";

type YoutubeReplyNodeData = {
  variableName?: string;
  replyMessage?: string;
};

type YoutubeReplyNodeType = Node<YoutubeReplyNodeData>;

export const YoutubeReplyNode = memo(
  (props: NodeProps<YoutubeReplyNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: YOUTUBE_REPLY_COMMENT_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchYoutubeReplyRealtimeToken,
    });

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: YoutubeReplyFormValues) => {
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
        <YoutubeReplyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={nodeData}
        />
        <BaseExecutionNode
          {...props}
          id={props.id}
          icon="/logos/youtube.svg"
          name="YouTube Reply"
          status={nodeStatus}
          description={description}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

YoutubeReplyNode.displayName = "YoutubeReplyNode";
