"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import {
  asFormat,
  FORMAT_META,
  legacyConversionToPair,
} from "@/lib/conversions";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { ConvertFormValues } from "./dialog";

const ConvertDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.ConvertDialog),
);

const option = getNodeOption(NodeType.CONVERT);

type ConvertNodeData = {
  to?: string;
  from?: string;
  /** Legacy single-enum field (pre-restructure nodes). */
  conversion?: string;
  input?: string;
};

type ConvertNodeType = Node<ConvertNodeData>;

export const ConvertNode = memo((props: NodeProps<ConvertNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: ConvertFormValues) => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === props.id
          ? { ...node, data: { ...node.data, ...values } }
          : node,
      ),
    );
  };

  const nodeData = props.data;
  const legacy = legacyConversionToPair(nodeData?.conversion);
  const to = asFormat(nodeData?.to) ?? legacy?.to;
  const from = asFormat(nodeData?.from) ?? legacy?.from;
  const description =
    nodeData?.input && to
      ? `${from ? FORMAT_META[from].label : "Auto"} → ${FORMAT_META[to].label}`
      : "Not configured";

  return (
    <>
      {dialogOpen && (
        <ConvertDialog
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
});

ConvertNode.displayName = "ConvertNode";
