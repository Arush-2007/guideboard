import type { Realtime } from "@inngest/realtime";
import { getExecutor } from "@/features/executions/lib/executor-registry";
import type { StepTools, WorkflowContext } from "@/features/executions/types";
import type { NodeType } from "@/generated/prisma";

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
  data: unknown;
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
  status: "SUCCESS" | "FAILED";
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
 * When a `recorder` is supplied, each node emits start/finish (or start/fail)
 * events carrying its input (incoming context), output (new-key diff), and
 * wall-clock duration — the single seam that gives per-node observability for
 * every node type without touching any executor.
 */
export async function runWorkflowNodes({
  sortedNodes,
  userId,
  initialData,
  step,
  publish,
  recorder,
}: {
  sortedNodes: ExecutableNode[];
  userId: string;
  initialData?: WorkflowContext;
  step: StepTools;
  publish: Realtime.PublishFn;
  recorder?: NodeRecorder;
}): Promise<WorkflowContext> {
  let context: WorkflowContext = initialData || {};

  let sequence = 0;
  for (const node of sortedNodes) {
    const executor = getExecutor(node.type as NodeType);
    const before = context;

    // Wall-clock around the executor: includes Inngest step/checkpoint and any
    // network overhead, so it's "elapsed time" rather than precise compute.
    const startedAt = Date.now();
    const base = {
      nodeId: node.id,
      nodeType: node.type as NodeType,
      nodeName: node.name,
      sequence,
      input: before,
    };
    try {
      const after = await executor({
        data: node.data as Record<string, unknown>,
        nodeId: node.id,
        userId,
        context: before,
        step,
        publish,
      });

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
