import { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";
import { TypeformTriggerDialog } from "./dialog";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { fetchTypeformTriggerRealtimeToken } from "./actions";
import { TYPEFORM_TRIGGER_CHANNEL_NAME } from "@/inngest/channels/typeform-trigger";

export const TypeformTrigger = memo((props: NodeProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  const nodeStatus = useNodeStatus({
    nodeId: props.id,
    channel: TYPEFORM_TRIGGER_CHANNEL_NAME,
    topic: "status",
    refreshToken: fetchTypeformTriggerRealtimeToken,
  });

  const handleOpenSettings = () => setDialogOpen(true);

  return (
    <>
      <TypeformTriggerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
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
