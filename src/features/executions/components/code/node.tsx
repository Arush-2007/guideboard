"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { CodeFormValues } from "./dialog";

const CodeDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.CodeDialog),
);

const option = getNodeOption(NodeType.CODE);

type CodeNodeData = {
  code?: string;
};

type CodeNodeType = Node<CodeNodeData>;

/** Longest code preview shown on the canvas before it gets an ellipsis. */
const MAX_DESCRIPTION_LENGTH = 32;

/**
 * Canvas summary: the first non-blank line of the code (code is multi-line and
 * unreadable at node size, so one line is all that fits). Comment lines are
 * skipped so the preview shows what the code *does*, not a header comment.
 */
function describeCode(code: string | undefined): string {
  const firstMeaningful = (code ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("//"));

  if (!firstMeaningful) return "Not configured";
  return firstMeaningful.length > MAX_DESCRIPTION_LENGTH
    ? `${firstMeaningful.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : firstMeaningful;
}

export const CodeNode = memo((props: NodeProps<CodeNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: CodeFormValues) => {
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
        <CodeDialog
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
        description={describeCode(props.data?.code)}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

CodeNode.displayName = "CodeNode";
