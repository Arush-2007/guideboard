"use client";

import type { NodeProps } from "@xyflow/react";
import { Webhook } from "lucide-react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { BaseTriggerNode } from "../base-trigger-node";

const WebhookTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.WebhookTriggerDialog),
);

export const WebhookTriggerNode = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <WebhookTriggerDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
      <BaseTriggerNode
        {...props}
        icon={Webhook}
        name="Webhook Trigger"
        description="When its URL receives a POST"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

WebhookTriggerNode.displayName = "WebhookTriggerNode";
