"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useState } from "react";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { RecordLookupFormValues } from "./dialog";

const RecordLookupDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.RecordLookupDialog),
);

type RecordLookupNodeData = {
  source?: "google_sheets" | "notion";
  value?: string;
  column?: string;
  property?: string;
  sheetName?: string;
};

type RecordLookupNodeType = Node<RecordLookupNodeData>;

export const RecordLookupNode = memo(
  (props: NodeProps<RecordLookupNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: RecordLookupFormValues) => {
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
    const target =
      nodeData?.source === "notion" ? nodeData?.property : nodeData?.column;
    const description = nodeData?.value
      ? `Find in ${target ?? "?"}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <RecordLookupDialog
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
          icon={Search}
          name="Record Lookup"
          status={nodeStatus}
          description={description}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

RecordLookupNode.displayName = "RecordLookupNode";
