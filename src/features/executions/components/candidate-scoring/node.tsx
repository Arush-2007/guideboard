"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { ClipboardCheck } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { CandidateScoringFormValues } from "./dialog";

const CandidateScoringDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.CandidateScoringDialog),
);

type CandidateScoringNodeData = Partial<CandidateScoringFormValues>;

type CandidateScoringNodeType = Node<CandidateScoringNodeData>;

export const CandidateScoringNode = memo(
  (props: NodeProps<CandidateScoringNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: CandidateScoringFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === props.id
            ? { ...node, data: { ...node.data, ...values } }
            : node,
        ),
      );
    };

    const nodeData = props.data;
    const ruleCount = nodeData?.rules?.length ?? 0;
    const description =
      nodeData?.provider === "affinda"
        ? "Affinda AI match"
        : ruleCount > 0
          ? `${ruleCount} rule${ruleCount === 1 ? "" : "s"} → shortlist ≥ ${nodeData?.shortlistThreshold ?? 60}`
          : "Not configured";

    return (
      <>
        {dialogOpen && (
          <CandidateScoringDialog
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
          icon={ClipboardCheck}
          name="Candidate Scoring"
          status={nodeStatus}
          description={description}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

CandidateScoringNode.displayName = "CandidateScoringNode";
