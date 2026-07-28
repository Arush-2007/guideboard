"use client";

import { type Node, type NodeProps, useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { lazyNodeDialog } from "@/components/lazy-node-dialog";
import { BaseTriggerNode } from "../base-trigger-node";
import type { GoogleSheetsTriggerSubmitValues } from "./dialog";

const GoogleSheetsTriggerDialog = lazyNodeDialog(() =>
  import("./dialog").then((mod) => mod.GoogleSheetsTriggerDialog),
);

import { getNodeOption } from "@/config/node-options";
import { useNodeStatus } from "@/features/executions/hooks/use-node-status";
import { NodeType } from "@/generated/prisma";
import type { RowScope } from "@/lib/sheet-style";

const option = getNodeOption(NodeType.GOOGLE_SHEETS_TRIGGER);

type GoogleSheetsTriggerNodeData = {
  spreadsheetId?: string;
  sheetName?: string;
  triggerOn?: "added" | "updated" | "added_or_updated";
  rowScope?: RowScope;
  ignoreColumns?: string[];
  discoveredFields?: { path: string; label: string }[];
};

type GoogleSheetsTriggerFlowNode = Node<GoogleSheetsTriggerNodeData>;

export const GoogleSheetsTriggerNode = memo(
  (props: NodeProps<GoogleSheetsTriggerFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: GoogleSheetsTriggerSubmitValues) => {
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id === props.id) {
            return {
              ...node,
              data: {
                ...node.data,
                ...values,
              },
            };
          }
          return node;
        }),
      );
    };

    // Name the scope on the canvas: watching a tab's section titles and watching
    // its data are different enough that two such nodes shouldn't read alike.
    const description = props.data?.sheetName
      ? props.data.rowScope === "headings"
        ? `Watching ${props.data.sheetName} headings`
        : `Watching ${props.data.sheetName}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <GoogleSheetsTriggerDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            currentNodeId={props.id}
            onSubmit={handleSubmit}
            defaultValues={props.data}
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

GoogleSheetsTriggerNode.displayName = "GoogleSheetsTriggerNode";
