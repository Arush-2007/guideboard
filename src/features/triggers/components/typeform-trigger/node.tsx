import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { BaseTriggerNode } from "../base-trigger-node";

const TypeformTriggerDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.TypeformTriggerDialog),
);

import { useNodeStatus } from "@/features/executions/hooks/use-node-status";

type TypeformTriggerNodeData = {
  credentialId?: string;
  formId?: string;
  formTitle?: string;
  discoveredFields?: { path: string; label: string }[];
};

type TypeformTriggerNodeType = Node<TypeformTriggerNodeData>;

export const TypeformTrigger = memo(
  (props: NodeProps<TypeformTriggerNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: TypeformTriggerNodeData) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === props.id
            ? { ...node, data: { ...node.data, ...values } }
            : node,
        ),
      );
    };

    const description = props.data?.formTitle
      ? `Form: ${props.data.formTitle}`
      : "When a Typeform response is submitted";

    return (
      <>
        {dialogOpen && (
          <TypeformTriggerDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={handleSubmit}
            defaultValues={props.data}
            currentNodeId={props.id}
          />
        )}
        <BaseTriggerNode
          {...props}
          icon="/logos/typeform.svg"
          name="Typeform Trigger"
          description={description}
          status={nodeStatus}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

TypeformTrigger.displayName = "TypeformTrigger";
