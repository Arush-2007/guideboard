import type { NodeProps } from "@xyflow/react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";

const ManualTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.ManualTriggerDialog),
);

import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.MANUAL_TRIGGER);

export const ManualTriggerNode = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <ManualTriggerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          currentNodeId={props.id}
        />
      )}
      <BaseTriggerNode
        {...props}
        icon={option.icon}
        // Canvas name intentionally differs from the picker label ("Trigger manually")
        name="When clicking 'Execute workflow'"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});
