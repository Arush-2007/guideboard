import type { Realtime } from "@inngest/realtime";
import type { GetStepTools, Inngest } from "inngest";

export type WorkflowContext = Record<string, unknown>;

export type StepTools = GetStepTools<Inngest.Any>;

export interface NodeExecutorParams<TData = Record<string, unknown>> {
  data: TData;
  nodeId: string;
  /**
   * The context key this node writes its output under — the node's stable
   * `ref` (e.g. `AI_TEXT_1`), resolved once by the engine. Executors must use
   * this instead of recomputing a key, so the write key always matches what the
   * variable picker advertises and downstream `!#...#!` references resolve.
   */
  outputKey: string;
  userId: string;
  context: WorkflowContext;
  step: StepTools;
  publish: Realtime.PublishFn;
}

export type NodeExecutor<TData = Record<string, unknown>> = (
  params: NodeExecutorParams<TData>,
) => Promise<WorkflowContext>;
