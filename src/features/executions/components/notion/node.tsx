"use client";

import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";
import { memo, useState } from "react";
import { useParams } from "next/navigation";
import { BaseExecutionNode } from "../base-execution-node";
import { NotionDialog, type NotionFormValues } from "./dialog";
import { useNodeStatus } from "../../hooks/use-node-status";
import { fetchNotionRealtimeToken } from "./actions";
import { NOTION_CHANNEL_NAME } from "@/inngest/channels/notion";

type NotionNodeData = {
  credentialId?: string;
  action?: "create_page" | "append_to_database";
  pageTitle?: string;
  content?: string;
  parentPageId?: string;
  databaseId?: string;
};

type NotionFlowNode = Node<NotionNodeData>;

export const NotionNode = memo((props: NodeProps<NotionFlowNode>) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { setNodes } = useReactFlow();
  const params = useParams();
  const workflowId =
    typeof params?.workflowId === "string" ? params.workflowId : undefined;

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: NOTION_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchNotionRealtimeToken,
  });

  const handleOpenSettings = () => setDialogOpen(true);

  const handleSubmit = (values: NotionFormValues) => {
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
  const description = nodeData?.pageTitle
    ? `${nodeData.action === "append_to_database" ? "DB: " : "Page: "}${nodeData.pageTitle.slice(0, 40)}${nodeData.pageTitle.length > 40 ? "…" : ""}`
    : "Not configured";

  return (
    <>
      <NotionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        defaultValues={nodeData}
        currentNodeId={props.id}
        workflowId={workflowId}
      />
      <BaseExecutionNode
        {...props}
        id={props.id}
        icon={Database}
        name="Notion"
        status={nodeStatus}
        description={description}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

NotionNode.displayName = "NotionNode";
