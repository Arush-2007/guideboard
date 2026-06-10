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
  data: unknown;
};

/**
 * Runs a workflow's nodes sequentially, threading the `context` object from one
 * node's output into the next node's input. This is the core of the execution
 * engine; `executeWorkflow` (src/inngest/functions.ts) wraps it with the
 * Execution-row bookkeeping, while integration tests drive it directly with a
 * shimmed `step`/`publish` to exercise the real executors end to end.
 *
 * `sortedNodes` must already be topologically sorted (see `topologicalSort`).
 */
export async function runWorkflowNodes({
  sortedNodes,
  userId,
  initialData,
  step,
  publish,
}: {
  sortedNodes: ExecutableNode[];
  userId: string;
  initialData?: WorkflowContext;
  step: StepTools;
  publish: Realtime.PublishFn;
}): Promise<WorkflowContext> {
  let context: WorkflowContext = initialData || {};

  for (const node of sortedNodes) {
    const executor = getExecutor(node.type as NodeType);
    context = await executor({
      data: node.data as Record<string, unknown>,
      nodeId: node.id,
      userId,
      context,
      step,
      publish,
    });
  }

  return context;
}
