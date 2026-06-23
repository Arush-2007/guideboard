import dynamic from "next/dynamic";
import { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";
const GoogleFormTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.GoogleFormTriggerDialog),
);
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";

export const GoogleFormTrigger = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus(props.id);

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      {dialogOpen && (
        <GoogleFormTriggerDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
      <BaseTriggerNode
        {...props}
        icon="/logos/googleform.svg"
        name="Google Form"
        description="When form is submitted"
        status={nodeStatus}
        onSettings={handleOpenSettings}
        onDoubleClick={handleOpenSettings}
      />
    </>
  );
});
