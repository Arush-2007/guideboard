"use client";

import { createId } from "@paralleldrive/cuid2";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { LocateFixedIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ErrorView, LoadingView } from "@/components/entity-components";
import { useSuspenseWorkflow } from "@/features/workflows/hooks/use-workflows";

import "@xyflow/react/dist/style.css";
import { useAtomValue, useSetAtom } from "jotai";
import { nodeComponents } from "@/config/node-components";
import { NodeStatusSubscriber } from "@/features/executions/components/node-status-subscriber";
import { deriveActiveChannels } from "@/features/executions/lib/node-status";
import { channelNameForNodeType } from "@/features/executions/lib/node-status-registry";
import { NodeType } from "@/generated/prisma";
import { nextNodeRef, nodeTypeHasRef } from "@/lib/node-ref";
import {
  editorAtom,
  STAGED_NODE_MIME,
  type StagedNode,
  stagedNodesAtom,
} from "../store/atoms";
import { AddNodeButton } from "./add-node-button";
import { ExecuteWorkflowButton } from "./execute-workflow-button";
import { StagingTray } from "./staging-tray";

// MiniMap with overlaid view controls: zoom in/out at the top-right of the
// minimap, and a "center view" (fit) button along its bottom. Replaces the
// default bottom-left <Controls /> bar. Lives in the bottom bar (a sibling of
// <ReactFlow>), so it relies on the surrounding <ReactFlowProvider> for store
// access rather than being a child of <ReactFlow>.
const MiniMapWithControls = () => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const controlButton =
    "flex items-center justify-center rounded-md border border-border/70 bg-card text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground";

  return (
    <div className="absolute bottom-[13.5px] right-[15px]">
      <div className="relative">
        <MiniMap
          className="!static !m-0 !h-[135px] !rounded-xl !border-2 !border-primary !bg-card"
          maskColor="transparent"
          pannable
          zoomable
        />
        <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomIn({ duration: 200 })}
            className={`${controlButton} size-[1.815rem]`}
          >
            <PlusIcon className="size-[1.059rem]" />
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomOut({ duration: 200 })}
            className={`${controlButton} size-[1.815rem]`}
          >
            <MinusIcon className="size-[1.059rem]" />
          </button>
        </div>
        <div className="absolute bottom-1.5 right-1.5 flex justify-end">
          <button
            type="button"
            aria-label="Center view"
            onClick={() => fitView({ duration: 300, maxZoom: 1.4 })}
            className={`${controlButton} h-[1.815rem] px-2 gap-1`}
          >
            <LocateFixedIcon className="size-[1.059rem]" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const EditorLoading = () => {
  return <LoadingView message="Loading editor..." />;
};

export const EditorError = () => {
  return <ErrorView message="Error loading editor" />;
};

export const Editor = ({ workflowId }: { workflowId: string }) => {
  const { data: workflow } = useSuspenseWorkflow(workflowId);

  const setEditor = useSetAtom(editorAtom);
  const editorInstance = useAtomValue(editorAtom);
  const setStaged = useSetAtom(stagedNodesAtom);

  const [nodes, setNodes] = useState<Node[]>(workflow.nodes);
  const [edges, setEdges] = useState<Edge[]>(workflow.edges);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((nodesSnapshot) => applyNodeChanges(changes, nodesSnapshot)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) =>
      setEdges((edgesSnapshot) => applyEdgeChanges(changes, edgesSnapshot)),
    [],
  );
  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((edgesSnapshot) => addEdge(params, edgesSnapshot)),
    [],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  // A staged node was dropped onto the canvas: create a real node at the drop
  // point and remove it from the staging tray.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();

      const raw = e.dataTransfer.getData(STAGED_NODE_MIME);
      if (!raw || !editorInstance) {
        return;
      }

      let staged: StagedNode;
      try {
        staged = JSON.parse(raw) as StagedNode;
      } catch {
        return;
      }

      const position = editorInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      setNodes((current) => {
        const hasInitialTrigger = current.some(
          (node) => node.type === NodeType.INITIAL,
        );

        // Assign the frozen ref at drop time (before any field can reference
        // this node), so the variable picker shows `AI_TEXT_1` immediately and
        // references are ref-based from the start — no rewrite ever needed.
        const existingRefs = current
          .map((node) => (node as { ref?: string | null }).ref)
          .filter((ref): ref is string => Boolean(ref));
        const ref = nodeTypeHasRef(staged.type)
          ? nextNodeRef(staged.type, existingRefs)
          : null;

        const newNode = {
          id: createId(),
          type: staged.type,
          position,
          data: {},
          ref,
        } as Node;

        return hasInitialTrigger ? [newNode] : [...current, newNode];
      });

      setStaged((prev) => prev.filter((node) => node.id !== staged.id));
    },
    [editorInstance, setStaged],
  );

  const hasManualTrigger = useMemo(() => {
    return nodes.some((node) => node.type === NodeType.MANUAL_TRIGGER);
  }, [nodes]);

  // Stable signature of the distinct node-type set: recomputed on every node
  // change but only *changes value* when a type appears/disappears. Keying the
  // active-channel list on it means subscriptions don't churn on node drags.
  const nodeTypeSignature = useMemo(() => {
    const types = new Set<string>();
    for (const node of nodes) {
      if (node.type) types.add(node.type);
    }
    return [...types].sort().join("|");
  }, [nodes]);

  const activeChannels = useMemo(
    () =>
      deriveActiveChannels(
        nodeTypeSignature ? nodeTypeSignature.split("|") : [],
        channelNameForNodeType,
      ),
    [nodeTypeSignature],
  );

  const defaultEdgeOptions = useMemo(
    () => ({
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 18,
        height: 18,
      },
    }),
    [],
  );

  const backgroundConfig = useMemo(
    () => ({
      variant: BackgroundVariant.Lines,
      gap: 24,
      size: 1,
      className: "opacity-35",
      color: "color-mix(in oklch, var(--primary) 22%, transparent)",
    }),
    [],
  );

  return (
    <ReactFlowProvider>
      <div className="flex size-full flex-col overflow-hidden border border-border/70 bg-card shadow-sm">
        {/* One realtime subscription per distinct channel on the canvas; each
            renders nothing and feeds the shared node-status atom. */}
        {activeChannels.map((channel) => (
          <NodeStatusSubscriber key={channel} channel={channel} />
        ))}
        {/* Canvas area — ends above the bottom bar so the minimap and staging
            tray no longer overlay the flow. Drop target for staged nodes. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: canvas drop zone for staged nodes */}
        <div
          className="relative flex-1"
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeComponents}
            defaultEdgeOptions={defaultEdgeOptions}
            onInit={setEditor}
            fitView
            fitViewOptions={{ maxZoom: 1.4 }}
            maxZoom={2}
            snapGrid={[10, 10]}
            snapToGrid
            panOnScroll
            panOnDrag={false}
            selectionOnDrag
          >
            <Background
              variant={backgroundConfig.variant}
              gap={backgroundConfig.gap}
              size={backgroundConfig.size}
              className={backgroundConfig.className}
              color={backgroundConfig.color}
            />
            <Panel position="top-right">
              <div className="rounded-xl border-2 border-primary bg-card p-1 shadow-sm">
                <AddNodeButton />
              </div>
            </Panel>
            {hasManualTrigger && (
              <Panel position="bottom-center">
                <div className="rounded-full border border-border/70 bg-card p-1 shadow-sm">
                  <ExecuteWorkflowButton workflowId={workflowId} />
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>
        {/* Bottom bar holding the staging tray (left) and the minimap (right),
            outside the canvas so neither covers the flow. */}
        <div className="relative h-[162px] shrink-0 border-t border-border/70 bg-background">
          <StagingTray />
          <MiniMapWithControls />
        </div>
      </div>
    </ReactFlowProvider>
  );
};
