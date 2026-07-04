"use client";

import {
  type Node,
  type NodeProps,
  useReactFlow,
  useUpdateNodeInternals,
} from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useEffect, useState } from "react";
import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { SwitchFormValues } from "./dialog";
import { switchOutputHandles } from "./handles";

const SwitchDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.SwitchDialog),
);

const option = getNodeOption(NodeType.SWITCH);

type SwitchNodeData = {
  cases?: SwitchFormValues["cases"];
};

type SwitchNodeType = Node<SwitchNodeData>;

export const SwitchNode = memo((props: NodeProps<SwitchNodeType>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: SwitchFormValues) => {
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

  const cases = props.data?.cases ?? [];
  const handles = switchOutputHandles(cases);
  const description =
    cases.length > 0 ? `${cases.length} case(s) → Default` : "Not configured";

  // The number of source handles changes as cases are added/removed. React Flow
  // caches handle geometry per node, so it must be told to re-measure whenever
  // the handle set changes — otherwise edges can't attach to new case handles
  // until a remount. `handleKey` is the change signal (intentionally not read in
  // the effect body).
  const handleKey = handles.map((h) => h.id).join(",");
  const updateNodeInternals = useUpdateNodeInternals();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on handle-set changes
  useEffect(() => {
    updateNodeInternals(props.id);
  }, [handleKey, props.id, updateNodeInternals]);

  return (
    <>
      {dialogOpen && (
        <SwitchDialog
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
        description={description}
        outputs={handles}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

SwitchNode.displayName = "SwitchNode";
