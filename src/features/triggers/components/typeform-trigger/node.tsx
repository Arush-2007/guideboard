import dynamic from "next/dynamic";
import { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";
const TypeformTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.TypeformTriggerDialog),
);
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";

export const TypeformTrigger = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <TypeformTriggerDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
      <BaseTriggerNode
        {...props}
        icon="/logos/typeform.svg"
        name="Typeform"
        description="When a Typeform response is submitted"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});
