import type { Edge } from "@xyflow/react";
import { nodeOutputs, resolveOutputPath } from "@/config/node-outputs";
import type { NodeType } from "@/generated/prisma";
import { getOutputKeyForNode } from "@/lib/node-ref";

/**
 * Pure logic behind the variable picker (`<VariablePicker>`). Kept React-free so
 * it can be unit-tested directly. Turns the canvas graph into the list of
 * upstream fields a node can reference, reading the `node-outputs.ts` registry
 * for field-level paths (falling back to the whole-output blob for node types
 * not yet declared there).
 */

/**
 * All nodes with a directed edge into `currentNodeId` (transitive) — every
 * upstream node whose output may be in context before this node runs.
 */
export function getUpstreamNodeIds(
  currentNodeId: string,
  edges: Pick<Edge, "source" | "target">[],
): Set<string> {
  const upstream = new Set<string>();

  function visit(id: string) {
    for (const e of edges) {
      if (e.target === id && e.source !== id && !upstream.has(e.source)) {
        upstream.add(e.source);
        visit(e.source);
      }
    }
  }

  visit(currentNodeId);
  return upstream;
}

export type UpstreamFieldRow = {
  nodeId: string;
  nodeType: string;
  /** Friendly node name for the group header, e.g. "telegram trigger". */
  nodeLabel: string;
  /** Friendly field name, e.g. "Sender first name" (or "Whole output"). */
  fieldLabel: string;
  /** The text inserted into the field, e.g. `@<telegram.from.firstName>@`. */
  insertText: string;
  example?: string;
};

type GraphNode = { id: string; type?: string | null; ref?: string | null };

/**
 * Flattened, ordered list of pickable fields from every node upstream of
 * `currentNodeId`. Declared nodes (in `node-outputs.ts`) expand into individual
 * fields; undeclared nodes contribute a single "whole output" entry.
 */
export function getUpstreamFields(
  currentNodeId: string,
  nodes: GraphNode[],
  edges: Pick<Edge, "source" | "target">[],
): UpstreamFieldRow[] {
  const upstreamIds = getUpstreamNodeIds(currentNodeId, edges);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const rows: UpstreamFieldRow[] = [];

  for (const id of [...upstreamIds].sort()) {
    const node = nodeById.get(id);
    if (!node?.type) continue;

    const type = node.type as NodeType;
    // Prefer the stable ref (e.g. "AI_TEXT_1") as the group header; fall back to
    // the humanized type for nodes that don't carry a ref (triggers, etc.).
    const nodeLabel =
      node.ref ?? String(node.type).replace(/_/g, " ").toLowerCase();
    const descriptor = nodeOutputs[type];

    if (descriptor) {
      for (const field of descriptor.fields) {
        const path = resolveOutputPath(type, id, field.path, node.ref);
        if (!path) continue;
        rows.push({
          nodeId: id,
          nodeType: String(node.type),
          nodeLabel,
          fieldLabel: field.label,
          insertText: `@<${path}>@`,
          example: field.example,
        });
      }
    } else {
      // Node type not declared in the registry yet — offer the whole blob so
      // power users can still drill in manually.
      rows.push({
        nodeId: id,
        nodeType: String(node.type),
        nodeLabel,
        fieldLabel: "Whole output",
        insertText: `@<${getOutputKeyForNode(String(node.type), id, node.ref)}>@`,
      });
    }
  }

  return rows;
}
