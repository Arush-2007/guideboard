import type { Realtime } from "@inngest/realtime";
import { getExecutor } from "@/features/executions/lib/executor-registry";
import {
  isRouted,
  type StepTools,
  type WorkflowContext,
} from "@/features/executions/types";
import type { NodeType } from "@/generated/prisma";
import { getOutputKeyForNode } from "@/lib/node-ref";

/**
 * The fields the engine actually reads off each node. Kept structural (rather
 * than the full Prisma `Node`) because `executeWorkflow` feeds in nodes that
 * have been round-tripped through Inngest's JSON step output, where `Date`
 * columns arrive as strings.
 */
export type ExecutableNode = {
  id: string;
  type: NodeType;
  name: string;
  /** Stable per-workflow reference key (e.g. `AI_TEXT_1`); see `node-ref.ts`. */
  ref?: string | null;
  data: unknown;
};

/**
 * The fields the engine reads off each connection for branch routing. Structural
 * for the same reason as `ExecutableNode` (Inngest round-trips JSON).
 */
export type ExecutableConnection = {
  fromNodeId: string;
  toNodeId: string;
  fromOutput: string;
  toInput: string;
};

/**
 * A single per-node record, emitted once when the node settles (success or
 * failure). Writing once-on-settle — instead of a RUNNING row up front plus an
 * update — halves the durable steps per node (Inngest bills per step), halves
 * the DB writes, and avoids orphan RUNNING rows. Live in-progress status is
 * served by the realtime channels, not these rows, so the live UI loses
 * nothing; the records survive mid-run failure because each node persists the
 * instant it settles, before any later node can throw.
 */
export interface NodeRecord {
  nodeId: string;
  nodeType: NodeType;
  nodeName: string;
  sequence: number;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  /** Context the node received. */
  input: WorkflowContext;
  /** New keys the node added; present on success only. */
  output?: WorkflowContext;
  /** Present on failure only. */
  error?: unknown;
  /** Wall-clock around the executor (includes Inngest step + network). */
  durationMs: number;
}

/**
 * Optional sink for per-node observability. Implemented by `executeWorkflow`
 * with a Prisma-backed writer (one `NodeExecution` row per node); left
 * undefined by the integration tests that drive the engine directly, so the
 * pure engine has no Prisma dependency. The implementation is responsible for
 * size-capping `input`/`output` before persisting.
 */
export interface NodeRecorder {
  record(node: NodeRecord): Promise<void>;
}

/**
 * A node's output is the set of keys it *added* to the context — NOT a
 * reference/value comparison. Executors only ever add a namespaced
 * `<type>_<nodeId>` key and never mutate existing ones, so the new-key set is
 * exactly their contribution. A reference diff would be wrong: the condition
 * node returns `context` through `step.run(...)`, and Inngest serializes step
 * output into a fresh deep copy, making every top-level reference differ even
 * though it added nothing.
 */
function newKeysDiff(
  before: WorkflowContext,
  after: WorkflowContext,
): WorkflowContext {
  const diff: WorkflowContext = {};
  for (const key of Object.keys(after)) {
    if (!(key in before)) diff[key] = after[key];
  }
  return diff;
}

/**
 * Runs a workflow's nodes sequentially, threading the `context` object from one
 * node's output into the next node's input. This is the core of the execution
 * engine; `executeWorkflow` (src/inngest/functions.ts) wraps it with the
 * Execution-row bookkeeping, while integration tests drive it directly with a
 * shimmed `step`/`publish` to exercise the real executors end to end.
 *
 * `sortedNodes` must already be topologically sorted (see `topologicalSort`).
 *
 * Branch routing: nodes are visited in topological order, but a node only runs
 * if it's reachable along an *active* path. A node runs when it has no incoming
 * connections (a trigger/root) or at least one incoming connection is active.
 * After a node runs, its outgoing connections become active per the activation
 * rule: a non-branching node (returns a plain context) activates *all* its
 * outgoing connections — preserving the original linear behavior with no data
 * migration — while a branching node (returns `routed(context, outputs)`)
 * activates only the connections whose `fromOutput` is in `outputs`. Nodes that
 * never become reachable are skipped (and recorded as SKIPPED).
 *
 * When a `recorder` is supplied, each node emits a settle (success/fail/skip)
 * event carrying its input (incoming context), output (new-key diff), and
 * wall-clock duration — the single seam that gives per-node observability for
 * every node type without touching any executor.
 */
export async function runWorkflowNodes({
  sortedNodes,
  connections = [],
  userId,
  initialData,
  step,
  publish,
  recorder,
}: {
  sortedNodes: ExecutableNode[];
  connections?: ExecutableConnection[];
  userId: string;
  initialData?: WorkflowContext;
  step: StepTools;
  publish: Realtime.PublishFn;
  recorder?: NodeRecorder;
}): Promise<WorkflowContext> {
  let context: WorkflowContext = initialData || {};

  // Index incoming connections per node so reachability is O(edges), not O(n²).
  const incomingByNode = new Map<string, ExecutableConnection[]>();
  for (const conn of connections) {
    const list = incomingByNode.get(conn.toNodeId);
    if (list) list.push(conn);
    else incomingByNode.set(conn.toNodeId, [conn]);
  }

  // Activation state for nodes that have already run, in topo order. A target's
  // incoming edge is "active" iff its source ran and either activated all
  // outputs (non-branching) or activated this edge's specific `fromOutput`.
  type Activation = { all: boolean; outputs: Set<string> };
  const activationByNode = new Map<string, Activation>();

  const isEdgeActive = (conn: ExecutableConnection): boolean => {
    const act = activationByNode.get(conn.fromNodeId);
    if (!act) return false; // source skipped or not yet run
    return act.all || act.outputs.has(conn.fromOutput);
  };

  let sequence = 0;
  for (const node of sortedNodes) {
    const before = context;
    const base = {
      nodeId: node.id,
      nodeType: node.type as NodeType,
      nodeName: node.name,
      sequence,
      input: before,
    };

    // Reachability: roots (no incoming edges) always run; everyone else needs at
    // least one active incoming edge.
    const incoming = incomingByNode.get(node.id) ?? [];
    const reachable = incoming.length === 0 || incoming.some(isEdgeActive);

    if (!reachable) {
      await recorder?.record({ ...base, status: "SKIPPED", durationMs: 0 });
      sequence++;
      continue;
    }

    const executor = getExecutor(node.type as NodeType);

    // Wall-clock around the executor: includes Inngest step/checkpoint and any
    // network overhead, so it's "elapsed time" rather than precise compute.
    const startedAt = Date.now();
    try {
      const result = await executor({
        data: node.data as Record<string, unknown>,
        nodeId: node.id,
        outputKey: getOutputKeyForNode(node.type, node.id, node.ref),
        userId,
        context: before,
        step,
        publish,
      });

      // Normalize the executor return into (next context, activated outputs).
      // Plain context => non-branching => activate all outgoing edges.
      const after = isRouted(result) ? result.context : result;
      activationByNode.set(
        node.id,
        isRouted(result)
          ? { all: false, outputs: new Set(result.outputs) }
          : { all: true, outputs: new Set() },
      );

      await recorder?.record({
        ...base,
        status: "SUCCESS",
        output: newKeysDiff(before, after),
        durationMs: Date.now() - startedAt,
      });

      context = after;
    } catch (error) {
      await recorder?.record({
        ...base,
        status: "FAILED",
        error,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    sequence++;
  }

  return context;
}
