"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { CalculatorFormValues } from "./dialog";
import { toReadableExpression } from "./keypad";

const CalculatorDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.CalculatorDialog),
);

const option = getNodeOption(NodeType.CALCULATOR);

type CalculatorNodeData = {
  expression?: string;
};

type CalculatorNodeType = Node<CalculatorNodeData>;

/** Longest expression shown on the canvas before it gets an ellipsis. */
const MAX_DESCRIPTION_LENGTH = 32;

/**
 * Canvas summary: the expression itself, with `@<AI_TEXT_1.output>@` shortened
 * to `AI_TEXT_1.output` — the raw token is far too long to read at node size.
 */
function describeExpression(expression: string | undefined): string {
  const readable = toReadableExpression(expression).trim();

  if (readable === "") return "Not configured";
  return readable.length > MAX_DESCRIPTION_LENGTH
    ? `${readable.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : readable;
}

export const CalculatorNode = memo((props: NodeProps<CalculatorNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: CalculatorFormValues) => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === props.id
          ? { ...node, data: { ...node.data, ...values } }
          : node,
      ),
    );
  };

  return (
    <>
      {dialogOpen && (
        <CalculatorDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleSubmit}
          defaultValues={props.data}
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
        description={describeExpression(props.data?.expression)}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

CalculatorNode.displayName = "CalculatorNode";
