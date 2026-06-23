import dynamic from "next/dynamic";
import { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";
const TelegramTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.TelegramTriggerDialog),
);
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";

export const TelegramTrigger = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <TelegramTriggerDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
      <BaseTriggerNode
        {...props}
        icon="/logos/telegram.svg"
        name="Telegram"
        description="When your bot receives a message"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});
