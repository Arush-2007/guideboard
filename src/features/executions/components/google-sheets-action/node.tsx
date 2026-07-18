"use client";

import {
  type Node,
  type NodeProps,
  useReactFlow,
  useUpdateNodeInternals,
} from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { memo, useEffect, useState } from "react";
import type { MultiMatchMode } from "@/lib/multi-match";
import type { RowMatchCondition } from "@/lib/row-match";
import { useNodeStatus } from "../../hooks/use-node-status";
import { BaseExecutionNode } from "../base-execution-node";
import type { GoogleSheetsActionSubmitValues } from "./dialog";
import { sheetsActionOutputHandles } from "./handles";

const GoogleSheetsActionDialog = dynamic(() =>
  import("./dialog").then((mod) => mod.GoogleSheetsActionDialog),
);

import { getNodeOption } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

const option = getNodeOption(NodeType.GOOGLE_SHEETS_ACTION);

type GoogleSheetsActionNodeData = {
  action?: "append_row" | "find_rows" | "update_row" | "color_rows";
  position?: "bottom" | "under_group" | "under_each";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  columnMappings?: Record<string, string>;
  requiredColumns?: string[];
  conditions?: RowMatchCondition[];
  onMultipleMatches?: MultiMatchMode;
  maxFanOutItems?: number;
  discoveredFields?: { path: string; label: string }[];
};

type GoogleSheetsActionFlowNode = Node<GoogleSheetsActionNodeData>;

export const GoogleSheetsActionNode = memo(
  (props: NodeProps<GoogleSheetsActionFlowNode>) => {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { setNodes } = useReactFlow();
    const params = useParams();
    const workflowId =
      typeof params?.workflowId === "string" ? params.workflowId : undefined;

    const nodeStatus = useNodeStatus(props.id);

    const handleOpenSettings = () => setDialogOpen(true);

    const handleSubmit = (values: GoogleSheetsActionSubmitValues) => {
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

    const nodeData = props.data;

    // find_rows / update_row branch (Found/Not-found, Updated/No-match); the
    // other two actions keep the single default handle. The handle set therefore
    // changes when the action is switched in the dialog, so React Flow — which
    // caches handle geometry per node — must be told to re-measure, exactly as
    // the Switch node does when cases are added or removed. `handleKey` is the
    // change signal (intentionally not read in the effect body).
    const outputs = sheetsActionOutputHandles(nodeData?.action);
    const handleKey = outputs?.map((h) => h.id).join(",") ?? "default";
    const updateNodeInternals = useUpdateNodeInternals();
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on handle-set changes
    useEffect(() => {
      updateNodeInternals(props.id);
    }, [handleKey, props.id, updateNodeInternals]);

    // A node saved before the insert_row_adjacent → append_row merge keeps the
    // old action + `insertUnder` until re-saved (this label reads the raw config,
    // which is only coerced at exec time / when the dialog opens). Normalize it to
    // a `position` so a legacy insert node still reads as "Insert…", not "Append".
    const legacy = nodeData as
      | { action?: string; insertUnder?: string }
      | undefined;
    const position =
      legacy?.action === "insert_row_adjacent"
        ? legacy.insertUnder === "each_row"
          ? "under_each"
          : "under_group"
        : nodeData?.position;

    const description = nodeData?.sheetName
      ? nodeData.action === "find_rows"
        ? `Find rows in ${nodeData.sheetName}`
        : nodeData.action === "update_row"
          ? `Update a row in ${nodeData.sheetName}`
          : nodeData.action === "color_rows"
            ? `Color rows in ${nodeData.sheetName}`
            : position === "under_each"
              ? `Insert rows into ${nodeData.sheetName}`
              : position === "under_group"
                ? `Insert a row into ${nodeData.sheetName}`
                : `Append to ${nodeData.sheetName}`
      : "Not configured";

    return (
      <>
        {dialogOpen && (
          <GoogleSheetsActionDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={handleSubmit}
            defaultValues={nodeData}
            currentNodeId={props.id}
            workflowId={workflowId}
          />
        )}
        <BaseExecutionNode
          {...props}
          id={props.id}
          icon={option.icon}
          name={option.label}
          status={nodeStatus}
          description={description}
          outputs={outputs}
          onSettings={handleOpenSettings}
          onDoubleClick={handleOpenSettings}
        />
      </>
    );
  },
);

GoogleSheetsActionNode.displayName = "GoogleSheetsActionNode";
