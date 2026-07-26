"use client";

import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";
import { BaseTriggerNode } from "../base-trigger-node";

const WebhookTriggerDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.WebhookTriggerDialog),
);

const option = getNodeOption(NodeType.WEBHOOK_TRIGGER);

export const WebhookTriggerNode = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <WebhookTriggerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          currentNodeId={props.id}
        />
      )}
      <BaseTriggerNode
        {...props}
        icon={option.icon}
        name={option.label}
        description="When its URL receives a POST"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});

WebhookTriggerNode.displayName = "WebhookTriggerNode";
