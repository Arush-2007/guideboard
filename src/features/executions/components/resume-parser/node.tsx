"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { ResumeParserFormValues } from "./dialog";

const ResumeParserDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.ResumeParserDialog),
);

const option = getNodeOption(NodeType.RESUME_PARSER);

type ResumeParserNodeData = {
  provider?: "builtin" | "affinda";
  sourceUrl?: string;
  skillKeywords?: string;
};

type ResumeParserNodeType = Node<ResumeParserNodeData>;

export const ResumeParserNode = memo(
  (props: NodeProps<ResumeParserNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: ResumeParserFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === props.id
            ? { ...node, data: { ...node.data, ...values } }
            : node,
        ),
      );
    };

    const nodeData = props.data;
    const description = nodeData?.sourceUrl
      ? `${nodeData.provider === "affinda" ? "Affinda" : "Built-in"} — ${nodeData.sourceUrl.slice(0, 32)}${nodeData.sourceUrl.length > 32 ? "…" : ""}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <ResumeParserDialog
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

ResumeParserNode.displayName = "ResumeParserNode";
