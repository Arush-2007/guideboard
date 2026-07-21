import { createId } from "@paralleldrive/cuid2";
import toposort from "toposort";
import type { Connection, Node } from "@/generated/prisma";
import { inngest } from "./client";

export const topologicalSort = (
  nodes: Node[],
  connections: Connection[],
): Node[] => {
  // If no connections, return node as-is (they're all independent)
  if (connections.length === 0) {
    return nodes;
  }

  // Create edges array for toposort (real connections only — self-edges are
  // treated as cycles by toposort, so orphan nodes are appended afterwards).
  const edges: [string, string][] = connections.map((conn) => [
    conn.fromNodeId,
    conn.toNodeId,
  ]);

  // Perform topological sort
  let sortedNodeIds: string[];
  try {
    sortedNodeIds = toposort(edges);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Cyclic")) {
      throw new Error("Workflow contains a cycle");
    }
    throw error;
  }

  // Map sorted IDs back to node objects
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sorted = sortedNodeIds
    .map((id) => nodeMap.get(id))
    .filter((n): n is Node => Boolean(n));

  // Append nodes that aren't part of any connection, preserving input order.
  const includedIds = new Set(sortedNodeIds);
  for (const node of nodes) {
    if (!includedIds.has(node.id)) {
      sorted.push(node);
    }
  }

  return sorted;
};

type SendWorkflowExecutionInput = {
  workflowId: string;
  initialData?: Record<string, unknown>;
  // R2 key of a stored context snapshot to seed the run with, instead of an
  // inline `initialData`. Used when the snapshot exceeded the inline clamp —
  // an oversized payload must not ride the Inngest event (event size limits),
  // so `executeWorkflow` hydrates it from blob storage inside a step.
  initialDataBlobKey?: string;
  idempotencyKey?: string;
  // Replay-from-node: run only this node + its descendants, seeding the context
  // from `initialData` (the node's recorded input snapshot). `replayOfExecutionId`
  // links the new run back to the origin for lineage. Both omitted on normal runs.
  replayFromNodeId?: string;
  replayOfExecutionId?: string;
};

/**
 * Callers pass a key naming the EXTERNAL EVENT only — `gmail:<messageId>`,
 * `youtube:<commentId>`, `google_sheets:<sheetId>:<row>:…` — never the
 * workflow. Two workflows watching the same inbox, sheet, chat or video
 * legitimately both handle the same event, and each should run.
 *
 * That is enforced by the `@@unique([workflowId, idempotencyKey])` constraint
 * on `Execution` (see the schema), which `executeWorkflow`'s `check-idempotency`
 * step reads through. Scoping lives in the constraint rather than in the key's
 * text so it is a fact the database holds, not a prefix convention every
 * producer has to apply and every reader has to strip.
 */
export const sendWorkflowExecution = async ({
  workflowId,
  initialData,
  initialDataBlobKey,
  idempotencyKey,
  replayFromNodeId,
  replayOfExecutionId,
}: SendWorkflowExecutionInput) => {
  return inngest.send({
    name: "workflows/execute.workflow",
    data: {
      workflowId,
      initialData: initialData ?? {},
      initialDataBlobKey,
      idempotencyKey,
      replayFromNodeId,
      replayOfExecutionId,
    },
    id: createId(),
  });
};
