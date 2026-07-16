"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { toast } from "sonner";
import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";
import { BaseTriggerNode } from "../base-trigger-node";
import { saveInstagramCommentTriggerConfig } from "./actions";
import type { InstagramCommentTriggerFormValues } from "./dialog";

const InstagramCommentTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.InstagramCommentTriggerDialog),
);

const option = getNodeOption(NodeType.INSTAGRAM_COMMENT_TRIGGER);

type InstagramCommentTriggerData = {
  postId?: string;
  /** Legacy; no longer set from UI */
  keywordFilter?: string;
  replyMessage?: string;
};

type InstagramCommentTriggerNode = Node<InstagramCommentTriggerData>;

export const InstagramCommentTriggerNode = memo(
  (props: NodeProps<InstagramCommentTriggerNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = async (values: InstagramCommentTriggerFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id === props.id) {
            return { ...node, data: { ...node.data, ...values } };
          }
          return node;
        }),
      );

      try {
        await saveInstagramCommentTriggerConfig(props.id, {
          postId: values.postId,
        });
      } catch {
        toast.error(
          "Failed to save trigger config. Your changes are saved locally until you save the workflow.",
        );
      }
    };

    const nodeData = props.data;
    const description = nodeData?.replyMessage
      ? `Reply: ${nodeData.replyMessage.slice(0, 40)}${nodeData.replyMessage.length > 40 ? "…" : ""}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <InstagramCommentTriggerDialog
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

InstagramCommentTriggerNode.displayName = "InstagramCommentTriggerNode";
