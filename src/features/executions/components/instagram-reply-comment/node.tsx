"use client";

import dynamic from "next/dynamic";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BaseExecutionNode } from "../base-execution-node";
import type { InstagramReplyFormValues } from "./dialog";
const InstagramReplyDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.InstagramReplyDialog),
);
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";

const option = getNodeOption(NodeType.INSTAGRAM_REPLY_COMMENT);

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

    const nodeStatus = useNodeStatus(props.id);

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
        {dialogOpen && (
          <InstagramReplyDialog
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

InstagramReplyNode.displayName = "InstagramReplyNode";
