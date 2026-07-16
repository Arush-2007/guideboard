"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { toast } from "sonner";
import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";
import { BaseTriggerNode } from "../base-trigger-node";
import { saveYoutubeCommentTriggerConfig } from "./actions";
import type { YoutubeCommentTriggerFormValues } from "./dialog";

const YoutubeCommentTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.YoutubeCommentTriggerDialog),
);

const option = getNodeOption(NodeType.YOUTUBE_COMMENT_TRIGGER);

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

    const nodeStatus = useNodeStatus(props.id);

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
        {dialogOpen && (
          <YoutubeCommentTriggerDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            currentNodeId={props.id}
            onSubmit={handleSubmit}
            defaultValues={nodeData}
          />
        )}
        <BaseTriggerNode
          {...props}
          icon={option.icon}
          name={option.label}
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
