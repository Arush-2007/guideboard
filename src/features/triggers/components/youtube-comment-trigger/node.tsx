"use client";

import { type NodeProps, type Node, useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { toast } from "sonner";
import { BaseTriggerNode } from "../base-trigger-node";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/youtube-comment-trigger";
import {
  fetchYoutubeCommentTriggerRealtimeToken,
  saveYoutubeCommentTriggerConfig,
} from "./actions";
import {
  YoutubeCommentTriggerDialog,
  type YoutubeCommentTriggerFormValues,
} from "./dialog";

type YoutubeCommentTriggerData = {
  videoId?: string;
  /** Legacy; no longer set from UI */
  keywordFilter?: string;
};

type YoutubeCommentTriggerNodeType = Node<YoutubeCommentTriggerData>;

export const YoutubeCommentTriggerNode = memo(
  (props: NodeProps<YoutubeCommentTriggerNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus({
      nodeId: props.id,
      channel: YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME,
      topic: "status",
      refreshToken: fetchYoutubeCommentTriggerRealtimeToken,
    });

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = async (values: YoutubeCommentTriggerFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id === props.id) {
            return { ...node, data: { ...node.data, ...values } };
          }
          return node;
        }),
      );

      try {
        await saveYoutubeCommentTriggerConfig(props.id, {
          videoId: values.videoId,
        });
      } catch {
        toast.error(
          "Failed to save trigger config. Your changes are saved locally until you save the workflow.",
        );
      }
    };

    const nodeData = props.data;
    const description = nodeData?.videoId
      ? `Video: ${nodeData.videoId.slice(0, 40)}${nodeData.videoId.length > 40 ? "…" : ""}`
      : "Not configured";

    return (
      <>
        <YoutubeCommentTriggerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={nodeData}
        />
        <BaseTriggerNode
          {...props}
          icon="/logos/youtube.svg"
          name="YouTube Comment Trigger"
          description={description}
          status={nodeStatus}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

YoutubeCommentTriggerNode.displayName = "YoutubeCommentTriggerNode";
