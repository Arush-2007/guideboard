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
 * Scopes a caller's idempotency key to one workflow.
 *
 * `Execution.idempotencyKey` is GLOBALLY unique, but almost every caller
 * derives its key purely from the external event — `gmail:<messageId>`,
 * `youtube:<commentId>`, `google_sheets:<sheetId>:<row>:…`. Two workflows
 * watching the same inbox, sheet, chat or video therefore compete for one key:
 * whichever poll lands first creates the Execution and the other is silently
 * dropped by `executeWorkflow`'s `check-idempotency` step. That is trivially
 * reachable — copy a workflow and save it, and the copy never runs — and worse
 * across TENANTS, since a YouTube comment id or a shared spreadsheet id is the
 * same string for every user watching it.
 *
 * The key is meant to mean "this workflow already handled this event", so the
 * workflow belongs in it. Scoping happens HERE, at the single door every
 * trigger goes through, rather than in each of the seven call sites that mint a
 * key — a new trigger cannot forget a rule it never has to apply.
 */
export const scopedIdempotencyKey = (workflowId: string, key: string): string =>
  `wf:${workflowId}:${key}`;

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
      idempotencyKey: idempotencyKey
        ? scopedIdempotencyKey(workflowId, idempotencyKey)
        : undefined,
      replayFromNodeId,
      replayOfExecutionId,
    },
    id: createId(),
  });
};
