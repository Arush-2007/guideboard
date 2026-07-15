"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { TelegramActionFormValues } from "./dialog";

const TelegramActionDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.TelegramActionDialog),
);

import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.TELEGRAM_ACTION);

type TelegramActionNodeData = {
  credentialId?: string;
  chatId?: string;
  message?: string;
};

type TelegramActionFlowNode = Node<TelegramActionNodeData>;

export const TelegramActionNode = memo(
  (props: NodeProps<TelegramActionFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: TelegramActionFormValues) => {
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
    const description = nodeData?.message
      ? `Send: ${nodeData.message.slice(0, 50)}${nodeData.message.length > 50 ? "…" : ""}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <TelegramActionDialog
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

TelegramActionNode.displayName = "TelegramActionNode";
