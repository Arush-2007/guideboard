import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { BaseTriggerNode } from "../base-trigger-node";

const TypeformTriggerDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.TypeformTriggerDialog),
);

import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.TYPEFORM_TRIGGER);

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
          icon={option.icon}
          name={option.label}
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
