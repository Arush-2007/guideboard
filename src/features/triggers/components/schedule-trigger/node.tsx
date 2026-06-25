"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { Clock } from "lucide-react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { cronToPreset, describeSchedule } from "@/lib/schedule-presets";
import { BaseTriggerNode } from "../base-trigger-node";
import type { ScheduleTriggerFormValues } from "./dialog";

const ScheduleTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.ScheduleTriggerDialog),
);

type ScheduleTriggerNodeData = {
  cron?: string;
  timezone?: string;
};

type ScheduleTriggerFlowNode = Node<ScheduleTriggerNodeData>;

export const ScheduleTriggerNode = memo(
  (props: NodeProps<ScheduleTriggerFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: ScheduleTriggerFormValues) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === props.id
            ? { ...node, data: { ...node.data, ...values } }
            : node,
        ),
      );
    };

    const description =
      props.data?.cron && props.data?.timezone
        ? describeSchedule(cronToPreset(props.data.cron), props.data.timezone)
        : "Not configured";

    return (
      <>
        {dialogOpen && (
          <ScheduleTriggerDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={handleSubmit}
            defaultValues={props.data}
          />
        )}
        <BaseTriggerNode
          {...props}
          icon={Clock}
          name="Schedule Trigger"
          description={description}
          status={nodeStatus}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

ScheduleTriggerNode.displayName = "ScheduleTriggerNode";
