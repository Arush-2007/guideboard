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
  type IsValidConnection,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { LocateFixedIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { useSuspenseWorkflow } from "@/features/workflows/hooks/use-workflows";

import "@xyflow/react/dist/style.css";
import { useAtomValue, useSetAtom } from "jotai";
import { nodeComponents } from "@/config/node-components";
import { getNodeConfigIssues } from "@/config/node-schemas";
import { NodeStatusSubscriber } from "@/features/executions/components/node-status-subscriber";
import { deriveActiveChannels } from "@/features/executions/lib/node-status";
import { channelNameForNodeType } from "@/features/executions/lib/node-status-registry";
import { NodeType } from "@/generated/prisma";
import {
  clearRefsForRemovedNodes,
  collectNodeRefs,
  withAssignedRef,
} from "@/lib/node-ref";
import { useEditorShortcuts } from "../hooks/use-editor-shortcuts";
import { invalidConnectionReason } from "../lib/connection-validation";
import { unrunnableNodes } from "../lib/connectivity";
import { serializeSnapshot } from "../lib/snapshot";
import {
  editorAtom,
  invalidNodeConfigAtom,
  isDirtyAtom,
  lastSavedSnapshotAtom,
  STAGED_NODE_MIME,
  type StagedNode,
  stagedNodesAtom,
  unrunnableNodesAtom,
} from "../store/atoms";
import { AddNodeButton } from "./add-node-button";
import { DeletableEdge } from "./deletable-edge";
import { ExecuteWorkflowButton } from "./execute-workflow-button";
import { HistoryController } from "./history-controller";
import { NavGuardDialog } from "./nav-guard-dialog";
import { StagingTray } from "./staging-tray";
import { UndoRedoButtons } from "./undo-redo-buttons";

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
    <div className="shrink-0">
      <div className="relative">
        <MiniMap
          className="!static !m-0 !h-editor-tray !rounded-xl !border-2 !border-primary !bg-card"
          maskColor="transparent"
          pannable
          zoomable
        />
        <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomIn({ duration: 200 })}
            className={`${controlButton} size-editor-control`}
          >
            <PlusIcon className="size-editor-control-icon" />
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomOut({ duration: 200 })}
            className={`${controlButton} size-editor-control`}
          >
            <MinusIcon className="size-editor-control-icon" />
          </button>
        </div>
        <div className="absolute bottom-1.5 right-1.5 flex justify-end">
          <button
            type="button"
            aria-label="Center view"
            onClick={() => fitView({ duration: 300, maxZoom: 1.4 })}
            className={`${controlButton} h-editor-control px-2 gap-1`}
          >
            <LocateFixedIcon className="size-editor-control-icon" />
          </button>
        </div>
      </div>
    </div>
  );
};

// The `fitView` prop only runs at mount, before custom nodes have measured
// dimensions, so it can land zoomed in off-center. Re-fit once after all nodes
// report as initialized so opening a workflow matches the minimap's center
// button. Must be a child of <ReactFlow> so the hooks see the flow store.
const FitViewOnLoad = () => {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const hasFit = useRef(false);

  useEffect(() => {
    if (nodesInitialized && !hasFit.current) {
      hasFit.current = true;
      fitView({ maxZoom: 1.4 });
    }
  }, [nodesInitialized, fitView]);

  return null;
};

// Tracks whether the canvas differs from the last-saved baseline and is the
// sole writer of `isDirtyAtom` (read by the header save button and the nav
// guard). It reads nodes/edges from the React Flow store — the *same* source
// the Save button persists (`editor.getNodes()`) — rather than the editor's
// local `useState`. Config-dialog edits go through `useReactFlow().setNodes`
// and land in the store; the local state only reliably reflects interactive
// changes like drags, so reading it here missed every configuration edit. Must
// be a child of <ReactFlowProvider>. It also owns the refresh/close guard so it
// fires off the same source of truth.
const DirtyTracker = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const lastSaved = useAtomValue(lastSavedSnapshotAtom);
  const setIsDirty = useSetAtom(isDirtyAtom);

  const isDirty = useMemo(() => {
    if (lastSaved === null) {
      return false;
    }
    return serializeSnapshot(nodes, edges) !== lastSaved;
  }, [nodes, edges, lastSaved]);

  useEffect(() => {
    setIsDirty(isDirty);
  }, [isDirty, setIsDirty]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  return null;
};

// Validates every node's config against the `node-schemas.ts` registry and is
// the sole writer of `invalidNodeConfigAtom` (read by the per-node "needs
// configuration" badge and the Execute button). Like <DirtyTracker>, it reads
// the React Flow store — the same source the Save button persists — because
// config-dialog edits go through `useReactFlow().setNodes` and land in the store,
// not editor.tsx's local `useState`. Must be a child of <ReactFlowProvider>.
//
// The validation loop runs on every store change (a cheap `safeParse` per node),
// but the atom is written ONLY when the invalid-map actually changes, so pure
// position drags never re-render the nodes that read it.
const ConfigValidator = () => {
  const nodes = useStore((state) => state.nodes);
  const setInvalid = useSetAtom(invalidNodeConfigAtom);
  const lastKeyRef = useRef("");

  useEffect(() => {
    const map: Record<string, string[]> = {};
    for (const node of nodes) {
      if (!node.type || node.type === NodeType.INITIAL) continue;
      const issues = getNodeConfigIssues(node.type as NodeType, node.data);
      if (issues.length > 0) map[node.id] = issues;
    }

    // Order-independent change key so React Flow reordering the nodes array
    // (e.g. elevate-on-select) can't masquerade as a config change.
    const key = Object.keys(map)
      .sort()
      .map((id) => `${id}:${map[id].join("|")}`)
      .join(";");
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setInvalid(map);
    }
  }, [nodes, setInvalid]);

  return null;
};

// Derives which nodes cannot run as wired (an unreachable action, or a trigger
// driving nothing) and is the sole writer of `unrunnableNodesAtom` (read by the
// per-node warning badge). Like <ConfigValidator>, it reads the React Flow store
// — the same source the Save button persists — so a wire deleted via the edge's
// × button, the Delete key, or an undo all reach it identically. Must be a child
// of <ReactFlowProvider>.
//
// The derivation runs on every store change (O(nodes + edges)), but the atom is
// written ONLY when the reason map actually changes, so node drags never
// re-render the nodes that read it.
const ConnectivityValidator = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const setUnrunnable = useSetAtom(unrunnableNodesAtom);
  // Seeded `null`, NOT "" — an empty map serializes to "", so a `""` seed would
  // make the first derivation of a clean canvas compare equal and skip its write,
  // leaving whatever the previously-opened workflow published in the atom. The
  // atom is an app-lifetime singleton (the jotai <Provider> is in the root
  // layout), so it outlives this component and that stale state would persist.
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const map = unrunnableNodes(nodes, edges);

    // Order-independent change key so React Flow reordering the nodes array
    // (e.g. elevate-on-select) can't masquerade as a connectivity change.
    const key = Object.keys(map)
      .sort()
      .map((id) => `${id}:${map[id]}`)
      .join(";");
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setUnrunnable(map);
    }
  }, [nodes, edges, setUnrunnable]);

  // Drop the map when the editor unmounts so a closed workflow can't leave
  // entries behind in the shared atom — same contract <HistoryController> keeps
  // for `historyControlsAtom`.
  useEffect(() => () => setUnrunnable({}), [setUnrunnable]);

  return null;
};

// Mounts the editor's global keyboard layer (Ctrl+S/Z/Shift+Z/Y/D/A). Renders
// nothing; lives inside <ReactFlowProvider> next to the other controllers.
// Receives editor.tsx's `setNodes` so duplicate/select-all write the
// authoritative controlled state (see the hook for why store-only writes are
// unsafe here).
const EditorShortcuts = ({
  workflowId,
  setNodes,
}: {
  workflowId: string;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
}) => {
  useEditorShortcuts(workflowId, setNodes);
  return null;
};

// Suspense fallback for the whole editor route: the fallback replaces both
// `EditorHeader` and the canvas `Editor` (both suspend on the same workflow
// query), so it mirrors the full chrome — header bar, canvas frame with a few
// ghost nodes and panel blocks, and the bottom tray/minimap bar — matching the
// real layout's flex math so nothing jumps when the editor mounts.
export const EditorLoading = () => {
  return (
    <>
      <div className="sticky top-0 z-20 flex h-editor-header shrink-0 items-center gap-2 border-b bg-background/95 px-4">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="absolute left-1/2 h-5 w-40 -translate-x-1/2" />
        <Skeleton className="ml-auto h-8 w-24 rounded-md" />
      </div>
      <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <div className="flex size-full flex-col overflow-hidden border border-border/70 bg-card shadow-sm">
            <div className="relative flex-1 overflow-hidden">
              <div className="absolute left-2 top-2">
                <Skeleton className="h-9 w-24 rounded-xl" />
              </div>
              <div className="absolute right-2 top-2">
                <Skeleton className="size-9 rounded-xl" />
              </div>
              <div className="flex h-full items-center justify-center gap-12">
                <Skeleton className="size-24 rounded-2xl" />
                <Skeleton className="size-24 rounded-2xl" />
                <Skeleton className="size-24 rounded-2xl" />
              </div>
            </div>
            <div className="flex h-editor-bar shrink-0 items-center justify-between border-t border-border/70 bg-background px-4">
              <Skeleton className="h-28 w-56 rounded-xl" />
              <Skeleton className="h-28 w-44 rounded-xl" />
            </div>
          </div>
        </div>
      </main>
    </>
  );
};

export const Editor = ({ workflowId }: { workflowId: string }) => {
  const { data: workflow } = useSuspenseWorkflow(workflowId);

  const setEditor = useSetAtom(editorAtom);
  const editorInstance = useAtomValue(editorAtom);
  const setStaged = useSetAtom(stagedNodesAtom);

  const [nodes, setNodes] = useState<Node[]>(workflow.nodes);
  const [edges, setEdges] = useState<Edge[]>(workflow.edges);

  const lastSaved = useAtomValue(lastSavedSnapshotAtom);
  const setLastSaved = useSetAtom(lastSavedSnapshotAtom);

  // Seed the saved-snapshot baseline for the loaded workflow, and re-seed when
  // the workflow id changes (a different workflow opened) or the baseline is
  // null. `workflow.nodes` is the last-persisted state, which is exactly the
  // baseline we want; it is the single writer of the baseline alongside the save
  // hook. The `null` case is defensive self-healing so nothing can leave
  // dirty-tracking permanently dead. The live comparison happens in
  // <DirtyTracker> off the React Flow store.
  const seededWorkflowId = useRef<string | null>(null);
  useEffect(() => {
    if (seededWorkflowId.current !== workflow.id || lastSaved === null) {
      seededWorkflowId.current = workflow.id;
      setLastSaved(serializeSnapshot(workflow.nodes, workflow.edges));
    }
  }, [workflow, lastSaved, setLastSaved]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((nodesSnapshot) => {
        const next = applyNodeChanges(changes, nodesSnapshot);

        // Deletions funnel through here (both the trash button via
        // `deleteElements` and the Delete key), so it's the one authoritative
        // place to clean up references to a removed node — blanking any
        // `@<deletedRef…>@` in the survivors so it can't silently re-point at a
        // future node that reclaims the same ref. Cheap guard first so the hot
        // drag/select path (no removals) never allocates.
        if (!changes.some((c) => c.type === "remove")) return next;

        // Read the removed nodes from the pre-change snapshot, since `next` no
        // longer contains them.
        const removedIds = new Set(
          changes.flatMap((c) => (c.type === "remove" ? [c.id] : [])),
        );
        const removed = nodesSnapshot.filter((n) => removedIds.has(n.id));
        return clearRefsForRemovedNodes(removed, next);
      }),
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

  // Draw-time guard: React Flow refuses to create an edge for which this returns
  // false (self-loop, an edge into a trigger, or one that would form a cycle the
  // engine's topological sort would later reject). React Flow calls this many
  // times per second while the pointer hovers a candidate handle, so the toast
  // uses a stable id: repeated calls update the one toast in place (no stacking)
  // and keep it visible for the whole hover, and each new attempt re-shows it.
  // Reading `nodes`/`edges` from the controlled state is current during a drag
  // since neither changes mid-drag.
  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      const reason = invalidConnectionReason(
        connection as Connection,
        nodes,
        edges,
      );
      if (reason) {
        toast.error(reason, { id: "invalid-connection" });
        return false;
      }
      return true;
    },
    [nodes, edges],
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

        // Replacing the INITIAL placeholder wipes the canvas, so the surviving
        // set — and therefore the refs the new node must not collide with — is
        // empty in that case and `current` otherwise.
        const survivors = hasInitialTrigger ? [] : current;

        // Stamp the ref here rather than letting the server assign it on save:
        // the node has to render as AI_TEXT_1 the moment it's dropped.
        const newNode: Node = withAssignedRef(
          {
            id: createId(),
            type: staged.type,
            position,
            data: {},
          },
          collectNodeRefs(survivors),
        );

        return [...survivors, newNode];
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

  const edgeTypes = useMemo(() => ({ deletable: DeletableEdge }), []);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "deletable",
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
        {/* Watches the React Flow store to keep `isDirtyAtom` in sync (renders
            nothing). Inside the provider so it can read the store. */}
        <DirtyTracker />
        {/* Validates node config against the schema registry off the same store,
            publishing `invalidNodeConfigAtom` for the per-node badge and the
            Execute button. Renders nothing. */}
        <ConfigValidator />
        {/* Derives which nodes can't run as wired off the same store, publishing
            `unrunnableNodesAtom` for the per-node warning triangle. Renders
            nothing. */}
        <ConnectivityValidator />
        {/* Owns undo/redo: observes the same store to record history and
            restores into it. Renders nothing; publishes controls for the
            toolbar buttons. Inside the provider so it can read the store, and
            fed editor.tsx's setters so a restore keeps the controlled prop in
            sync. */}
        <HistoryController
          setNodes={setNodes}
          setEdges={setEdges}
          initialNodes={workflow.nodes}
          initialEdges={workflow.edges}
          workflowId={workflowId}
        />
        {/* Global keyboard shortcuts (save, undo/redo, duplicate, select-all).
            Renders nothing; inside the provider and fed setNodes so duplicate/
            select-all keep the controlled state authoritative. */}
        <EditorShortcuts workflowId={workflowId} setNodes={setNodes} />
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
            isValidConnection={isValidConnection}
            nodeTypes={nodeComponents}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            onInit={setEditor}
            deleteKeyCode={["Delete", "Backspace"]}
            fitView
            fitViewOptions={{ maxZoom: 1.4 }}
            maxZoom={2}
            snapGrid={[10, 10]}
            snapToGrid
            panOnScroll
            panOnDrag={false}
            selectionOnDrag
          >
            <FitViewOnLoad />
            <Background
              variant={backgroundConfig.variant}
              gap={backgroundConfig.gap}
              size={backgroundConfig.size}
              className={backgroundConfig.className}
              color={backgroundConfig.color}
            />
            <Panel position="top-left">
              <div className="rounded-xl border-2 border-primary bg-card p-1 shadow-sm">
                <UndoRedoButtons />
              </div>
            </Panel>
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
        <div className="flex h-editor-bar shrink-0 items-center justify-between gap-4 border-t border-border/70 bg-background px-4">
          <StagingTray />
          <MiniMapWithControls />
        </div>
        <NavGuardDialog workflowId={workflowId} />
      </div>
    </ReactFlowProvider>
  );
};
