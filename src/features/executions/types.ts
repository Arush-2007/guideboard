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
   * variable picker advertises and downstream `@<...>@` references resolve.
   */
  outputKey: string;
  userId: string;
  context: WorkflowContext;
  step: StepTools;
  publish: Realtime.PublishFn;
}

/**
 * Branded result for nodes that route execution down specific output handles.
 * Most executors just return a `WorkflowContext` (they're non-branching, and the
 * engine activates *all* their outgoing connections). Branching nodes — Condition,
 * Switch — return `routed(context, [...handleIds])` instead, and the engine then
 * activates only the outgoing connections whose `fromOutput` is in `outputs`.
 *
 * The symbol brand makes `isRouted` unambiguous: a plain context can never
 * accidentally look like a `NodeOutcome`.
 */
const ROUTED: unique symbol = Symbol("routed");

export interface NodeOutcome {
  [ROUTED]: true;
  context: WorkflowContext;
  /** Active output handle ids, e.g. `["true"]` or `["case_2"]`. */
  outputs: string[];
}

export function routed(
  context: WorkflowContext,
  outputs: string[],
): NodeOutcome {
  return { [ROUTED]: true, context, outputs };
}

export function isRouted(value: unknown): value is NodeOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[ROUTED] === true
  );
}

export type NodeExecutor<TData = Record<string, unknown>> = (
  params: NodeExecutorParams<TData>,
) => Promise<WorkflowContext | NodeOutcome>;
