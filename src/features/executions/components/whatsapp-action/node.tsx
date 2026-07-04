"use client";

import dynamic from "next/dynamic";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { WhatsappActionFormValues } from "./dialog";
const WhatsappActionDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.WhatsappActionDialog),
);
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.WHATSAPP_ACTION);

type WhatsappActionNodeData = {
  recipientPhones?: string[];
  /** Legacy single-recipient field, still read for backward compatibility. */
  recipientPhone?: string;
  message?: string;
};

type WhatsappActionNodeType = Node<WhatsappActionNodeData>;

export const WhatsappActionNode = memo(
  (props: NodeProps<WhatsappActionNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: WhatsappActionFormValues) => {
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
    const recipientCount =
      (nodeData?.recipientPhones?.filter((p) => p.trim()).length ?? 0) ||
      (nodeData?.recipientPhone?.trim() ? 1 : 0);
    const description = nodeData?.message
      ? `${recipientCount} recipient${recipientCount === 1 ? "" : "s"} — ${nodeData.message.slice(0, 36)}${nodeData.message.length > 36 ? "…" : ""}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <WhatsappActionDialog
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

WhatsappActionNode.displayName = "WhatsappActionNode";
