import type { NodeProps } from "@xyflow/react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";

const GmailTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.GmailTriggerDialog),
);

import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.GMAIL_TRIGGER);

export const GmailTriggerNode = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <GmailTriggerDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
      <BaseTriggerNode
        {...props}
        icon={option.icon}
        name={option.label}
        description="When a new unread email is received"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});
