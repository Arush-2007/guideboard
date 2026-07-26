import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { BaseTriggerNode } from "../base-trigger-node";

const GoogleFormTriggerDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.GoogleFormTriggerDialog),
);

import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.GOOGLE_FORM_TRIGGER);

type GoogleFormTriggerNodeData = {
  formId?: string;
  formTitle?: string;
  discoveredFields?: { path: string; label: string }[];
};

type GoogleFormTriggerNodeType = Node<GoogleFormTriggerNodeData>;

export const GoogleFormTrigger = memo(
  (props: NodeProps<GoogleFormTriggerNodeType>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: GoogleFormTriggerNodeData) => {
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
      : "When form is submitted";

    return (
      <>
        {dialogOpen && (
          <GoogleFormTriggerDialog
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

GoogleFormTrigger.displayName = "GoogleFormTrigger";
