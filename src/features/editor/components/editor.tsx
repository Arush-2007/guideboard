"use client";

import { useState, useCallback, useMemo } from "react";
import { 
  ReactFlow, 
  applyNodeChanges, 
  applyEdgeChanges, 
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
} from '@xyflow/react';
import { ErrorView, LoadingView } from "@/components/entity-components";
import { useSuspenseWorkflow } from "@/features/workflows/hooks/use-workflows";

import '@xyflow/react/dist/style.css';
import { nodeComponents } from '@/config/node-components';
import { AddNodeButton } from './add-node-button';
import { useSetAtom } from 'jotai';
import { editorAtom } from '../store/atoms';
import { NodeType } from '@/generated/prisma';
import { ExecuteWorkflowButton } from './execute-workflow-button';

export const EditorLoading = () => {
  return <LoadingView message="Loading editor..." />;
};

export const EditorError = () => {
  return <ErrorView message="Error loading editor" />;
};

export const Editor = ({ workflowId }: { workflowId: string }) => {
  const { 
    data: workflow
  } = useSuspenseWorkflow(workflowId);

  const setEditor = useSetAtom(editorAtom);

  const [nodes, setNodes] = useState<Node[]>(workflow.nodes);
  const [edges, setEdges] = useState<Edge[]>(workflow.edges);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nodesSnapshot) => applyNodeChanges(changes, nodesSnapshot)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((edgesSnapshot) => applyEdgeChanges(changes, edgesSnapshot)),
    [],
  );
  const onConnect = useCallback(
    (params: Connection) => setEdges((edgesSnapshot) => addEdge(params, edgesSnapshot)),
    [],
  );

  const hasManualTrigger = useMemo(() => {
    return nodes.some((node) => node.type === NodeType.MANUAL_TRIGGER);
  }, [nodes]);

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
    <div className="size-full overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeComponents}
        onInit={setEditor}
        fitView
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
        <Controls className="rounded-xl border border-border/70 bg-card shadow-sm" />
        <MiniMap
          className="!rounded-xl !border !border-border/70 !bg-card"
          maskColor="transparent"
          pannable
          zoomable
        />
        <Panel position="top-right">
          <div className="rounded-xl border border-border/70 bg-card p-1 shadow-sm">
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
  );
};
