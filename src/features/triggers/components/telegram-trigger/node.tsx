import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { BaseTriggerNode } from "../base-trigger-node";

const TelegramTriggerDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.TelegramTriggerDialog),
);

import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.TELEGRAM_TRIGGER);

export const TelegramTrigger = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <TelegramTriggerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          currentNodeId={props.id}
        />
      )}
      <BaseTriggerNode
        {...props}
        icon={option.icon}
        name={option.label}
        description="When your bot receives a message"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});
