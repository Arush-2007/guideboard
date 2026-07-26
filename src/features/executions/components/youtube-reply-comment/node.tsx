"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { BaseExecutionNode } from "../base-execution-node";
import type { YoutubeReplyFormValues } from "./dialog";

const YoutubeReplyDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.YoutubeReplyDialog),
);

import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";

const option = getNodeOption(NodeType.YOUTUBE_REPLY_COMMENT);

type YoutubeReplyNodeData = {
  variableName?: string;
  replyMessage?: string;
};

type YoutubeReplyNodeType = Node<YoutubeReplyNodeData>;

export const YoutubeReplyNode = memo(
  (props: NodeProps<YoutubeReplyNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

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
        {dialogOpen && (
          <YoutubeReplyDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={handleSubmit}
            defaultValues={nodeData}
            currentNodeId={props.id}
            workflowId={workflowId}
          />
        )}
        <BaseExecutionNode
          {...props}
          id={props.id}
          icon={option.icon}
          name={option.label}
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
