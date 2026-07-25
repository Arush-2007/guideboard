import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";

/**
 * The authoritative canvas graph: the React Flow STORE once it has initialized,
 * else the controlled `useState` snapshot.
 *
 * Every seam that reads the graph in order to build the next one must go through
 * these. Config-dialog saves go through `useReactFlow().setNodes` and land
 * ONLY in the store (see `<DirtyTracker>` / `<ConfigValidator>`), so the
 * `useState` snapshot is routinely STALE — and applying a change on top of it
 * writes that stale graph back over the store, silently reverting every config
 * edit made since the last interactive one. That is one bug class with several
 * faces: a correct "cannot run / not connected" badge vanishing the moment any
 * node's dialog was opened, Ctrl+A reverting a just-saved config, and Ctrl+D
 * cloning the pre-edit version of a node. The store is the single source of
 * truth that Save, dirty-tracking and both validators already read.
 *
 * Named rather than inlined because the invariant kept being re-derived at each
 * new seam, and the seam that missed it was the one that regressed. A call to
 * `liveNodes` is greppable; `editor?.getNodes() ?? nodes` on its own reads like
 * an incidental null-check.
 *
 * The fallback is load-bearing, not decoration: before React Flow calls
 * `onInit` the instance atom is still null and the controlled state is the only
 * graph that exists.
 */
export function liveNodes(
  editor: ReactFlowInstance | null,
  fallback: Node[],
): Node[] {
  return editor?.getNodes() ?? fallback;
}

/** Edge half of {@link liveNodes}, with the same staleness reasoning. */
export function liveEdges(
  editor: ReactFlowInstance | null,
  fallback: Edge[],
): Edge[] {
  return editor?.getEdges() ?? fallback;
}
