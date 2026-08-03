import type { Realtime } from "@inngest/realtime";
import { NonRetriableError } from "inngest";
import { requiresCheckpoint, TRIGGER_NODE_TYPES } from "@/config/node-kinds";
import { getExecutor } from "@/features/executions/lib/executor-registry";
import {
  type ExecutorStep,
  isFanOut,
  isRouted,
  type StepTools,
  type WorkflowContext,
} from "@/features/executions/types";
import type { NodeType } from "@/generated/prisma";
import { directPublish } from "@/inngest/direct-publish";
import { isFanOutItem } from "@/inngest/fan-out";
import { MAX_STEP_BUDGET_MS, STEP_OVERHEAD_MS } from "@/lib/http-budget";
import { logger } from "@/lib/logger";
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
  /**
   * When the engine OBSERVED this node settle — captured at buffering time, not
   * at write time.
   *
   * Load-bearing for the deferred write: records are flushed inside a later
   * step, so stamping the row when it is written would collapse every node's
   * `completedAt` onto one instant and destroy the per-node timeline. Capturing
   * it here makes flush time irrelevant to the data.
   */
  completedAt: Date;
}

/**
 * Optional sink for per-node observability. Implemented by `executeWorkflow`
 * with a Prisma-backed writer (one `NodeExecution` row per node); left
 * undefined by the integration tests that drive the engine directly, so the
 * pure engine has no Prisma dependency. The implementation is responsible for
 * size-capping `input`/`output` before persisting.
 *
 * Takes a BATCH, not one record, because the engine buffers settled nodes and
 * flushes them inside a step it is already paying for — see `flushPending`. The
 * implementation must be idempotent: the same record can be offered more than
 * once (a replayed invocation rebuilds the same buffer), and writing it twice
 * must not duplicate a row or move its timestamps.
 */
export interface NodeRecorder {
  flush(records: NodeRecord[]): Promise<void>;
  /**
   * Which of these nodes already have a durable record, i.e. settled during an
   * EARLIER invocation of this run.
   *
   * Not for recording — for suppressing repeat status publishes. Inngest
   * re-executes the handler body at every step boundary, so a completed node's
   * executor body (and its `publish("loading")` / `publish("success")`) runs
   * again on every later invocation. While publishing was a memoized
   * `step.run`, those repeats cost nothing; now that it is a direct call they
   * are real blocking HTTP, O(K²) of it across a run — and they tell the canvas
   * that a finished node is loading again.
   *
   * Optional: engine tests supply a recorder without it and simply publish
   * every time, which is correct-if-chatty.
   */
  settledNodeIds?(nodeIds: string[]): Promise<Set<string>>;
}

/**
 * Optional sink for a node's fan-out. Implemented by `executeWorkflow` with an
 * Inngest/blob-backed dispatcher that turns each item into a child
 * sub-execution (a replay-from-node run of `nodeId` + descendants, seeded with
 * the per-item payload); left undefined by tests that don't exercise fan-out.
 * A node returning `fanOut(...)` with no dispatcher wired in is a wiring bug and
 * the engine throws rather than silently dropping the items.
 */
export interface FanOutDispatcher {
  dispatch(args: {
    nodeId: string;
    outputKey: string;
    context: WorkflowContext;
    items: unknown[];
  }): Promise<void>;
}

/**
 * A node's output is the set of keys it *added* to the context — NOT a
 * reference/value comparison. Executors only ever add a namespaced
 * `<type>_<nodeId>` key and never mutate existing ones, so the new-key set is
 * exactly their contribution. A reference diff would be wrong: the condition
 * node returns `context` through `step.run(...)`, and Inngest serializes step
 * output into a fresh deep copy, making every top-level reference differ even
 * though it added nothing.
 *
 * One deliberate exception: in a fan-out CHILD run the fanned-out node's own
 * key already exists (the dispatcher seeded it with the per-item payload) and
 * its executor rewrites that key in place with its per-item output. A key
 * whose before-value is a per-item seed is therefore compared BY VALUE, so the
 * rewrite is recorded as the node's output while downstream nodes — which only
 * carry the (value-identical) rewrite through their own step round-trips —
 * still record nothing for it.
 */
function newKeysDiff(
  before: WorkflowContext,
  after: WorkflowContext,
): WorkflowContext {
  const diff: WorkflowContext = {};
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      diff[key] = after[key];
    } else if (
      isFanOutItem(before[key]) &&
      !sameJson(before[key], after[key])
    ) {
      diff[key] = after[key];
    }
  }
  return diff;
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Unserializable — assume unchanged rather than over-record.
    return true;
  }
}

/**
 * Forward-reachable set from `start` over the connection graph, including
 * `start` itself. Used by replay-from-node: the run executes exactly
 * `{start} ∪ descendants(start)` and treats everything upstream as already-run
 * (its output is pre-seeded into the context). Iterative DFS so a deep graph
 * can't blow the stack; the visited set makes cycles/diamonds O(edges).
 */
function forwardReachableFrom(
  start: string,
  connections: ExecutableConnection[],
): Set<string> {
  const outgoingByNode = new Map<string, string[]>();
  for (const conn of connections) {
    const list = outgoingByNode.get(conn.fromNodeId);
    if (list) list.push(conn.toNodeId);
    else outgoingByNode.set(conn.fromNodeId, [conn.toNodeId]);
  }

  const reachable = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of outgoingByNode.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }
  return reachable;
}

/**
 * The longest a single inline-safe node can occupy inside a segment.
 *
 * Every `false` entry in `CHECKPOINTED_NODE_TYPES` makes no unbounded
 * third-party call (that is question 4 there, and it exists to keep this number
 * meaningful). Triggers and the pure-computation nodes are effectively instant;
 * the only one with a real clock is `CODE`, whose QuickJS interrupt deadline
 * hard-stops it at 1s (`DEFAULT_TIMEOUT_MS`, `js-sandbox.ts`).
 *
 * ⚠️ If a node type is ever classified inline-safe while making a network call,
 * this constant becomes fiction and the cap below with it.
 */
export const WORST_INLINE_NODE_MS = 1_000;

/**
 * How many nodes one batched segment may hold.
 *
 * A segment runs entirely inside ONE Inngest step, so it must fit inside one
 * platform invocation. Per-node checkpointing never had this problem — each node
 * was its own invocation — so this ceiling arrived with batching.
 *
 * DERIVED, not chosen. An earlier version asserted 25 against "Vercel kills a
 * function at 300s", which contradicted `MAX_STEP_BUDGET_MS` — the repo's own
 * figure for the same platform limit, 5× smaller and deliberately conservative.
 * Two numbers for one ceiling is how a cap silently stops protecting anything,
 * so this one is computed from that single source instead:
 *
 *     usable   = MAX_STEP_BUDGET_MS - STEP_OVERHEAD_MS   = 55s
 *     worst    = WORST_INLINE_NODE_MS                    =  1s
 *     25 nodes = 25s                                     ⇒ 2.2× headroom
 *
 * The headroom is deliberate: `WORST_INLINE_NODE_MS` bounds the executor, not
 * the realtime `publish()` calls around it, which are HTTP and unmeasured here.
 *
 * ⚠️ DEPLOY-UNSAFE. Changing this re-partitions segments, which changes the
 * `nodes:i-j` step ids, which means any run in flight across the deploy
 * re-executes its already-completed inline nodes. That is harmless only because
 * inline-safe nodes are re-runnable by definition — so it stays harmless only
 * while `CHECKPOINTED_NODE_TYPES` is honest. Prefer changing it during a quiet
 * window.
 */
export const MAX_SEGMENT_NODES = Math.min(
  25,
  Math.floor((MAX_STEP_BUDGET_MS - STEP_OVERHEAD_MS) / WORST_INLINE_NODE_MS),
);

/**
 * The step API handed to nodes running INSIDE a batched segment.
 *
 * Runs their work immediately rather than checkpointing it, because the
 * enclosing segment already IS the checkpoint and Inngest steps cannot nest.
 *
 * The cast is deliberate and marks the one place the shim and the real thing
 * genuinely differ: Inngest's `step.run` returns `Jsonify<T>` (the value has
 * been through JSON), while this returns `T` untouched — so a `Date` stays a
 * `Date` here where a checkpoint would have made it a string. That is a
 * WIDENING, never a loss, and it cannot escape the segment: the segment's own
 * `step.run` JSON-round-trips the context on the way out. Only inline-safe types
 * see this shim, and none of them put non-JSON values into the context.
 *
 * ⚠️ The cast also means the type system checks nothing here. `ExecutorStep` is
 * `Pick<StepTools, "run" | "ai">`, and `ai` carries `infer` and `models` as well
 * as `wrap` — so an executor reaching for one of those compiles cleanly and
 * would hit `undefined is not a function` the first time it landed in a batch.
 * They are implemented rather than omitted for that reason; `infer` throws a
 * legible error instead of pretending, because it asks the PLATFORM to perform
 * the inference and there is nothing to run inline.
 */
const inlineStep = {
  // Trailing input is forwarded, matching `flushingStep` and real `step.run`.
  // Dropping it would hand an executor `undefined` for arguments it declared,
  // and only when its node happened to be batched — a failure that appears in
  // the hardest place to attribute it.
  run: async (
    _id: string,
    fn: (...input: unknown[]) => unknown,
    ...input: unknown[]
  ) => fn(...input),
  ai: {
    wrap: async (
      _id: string,
      fn: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => fn(...args),
    // Unreachable today — every AI node is checkpointed, and all five use
    // `wrap`. If that ever changes, fail with an actionable message rather than
    // a TypeError from a missing method.
    infer: async () => {
      throw new NonRetriableError(
        "step.ai.infer() cannot run inside a batched segment — it is executed " +
          "by the Inngest platform, not by this process. Mark the node type " +
          "`true` in CHECKPOINTED_NODE_TYPES (src/config/node-kinds.ts).",
      );
    },
    // Pure model descriptors, no execution — safe to pass through untouched.
    models: {},
  },
} as unknown as ExecutorStep;

/**
 * Wraps the real step so every callback flushes buffered node records first.
 *
 * The engine cannot detect whether a node just ran: the invocation in which a
 * step callback executes is always abandoned before control returns, so "did it
 * execute" and "did control reach the recorder" are mutually exclusive. What it
 * CAN rely on is that a callback runs exactly once and is memoized forever
 * after — making it a free, exactly-once write point.
 *
 * `...input` is forwarded on both paths because `createStepRun` persists trailing
 * input for `run` as well as `ai.wrap`; dropping it would silently discard it. On
 * `ai.wrap` the callback must be invoked with the SDK-supplied arguments (`...a`)
 * rather than the captured ones — on replay the SDK substitutes the memoized
 * input, and closing over the outer values would quietly diverge from it.
 */
function flushingStep(
  real: ExecutorStep,
  flush: () => Promise<void>,
): ExecutorStep {
  const hook =
    <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) =>
    async (...args: TArgs) => {
      await flush();
      return fn(...args);
    };

  return {
    run: (id: unknown, fn: unknown, ...input: unknown[]) =>
      (real.run as (...a: unknown[]) => unknown)(
        id,
        hook(fn as (...a: unknown[]) => unknown),
        ...input,
      ),
    ai: {
      ...real.ai,
      wrap: (id: unknown, fn: unknown, ...args: unknown[]) =>
        (real.ai.wrap as (...a: unknown[]) => unknown)(
          id,
          hook(fn as (...a: unknown[]) => unknown),
          ...args,
        ),
    },
  } as unknown as ExecutorStep;
}

/** A node's outgoing-edge activation, in the form that survives JSON. */
type SerializedActivation = { all: boolean; outputs: string[] };

/**
 * What a batched segment hands back across its checkpoint.
 *
 * Everything a later segment needs must travel through here rather than through
 * closure state. On a REPLAY the segment's body never runs — Inngest returns the
 * memoized value — so any state the body only mutated in memory would silently
 * be lost. `sequence` needs no entry: it is exactly the node's index in
 * `sortedNodes` (every path through the loop advances it once).
 */
type SegmentResult = {
  context: WorkflowContext;
  /** Only this segment's own nodes; earlier ones are already applied. */
  activations: Array<[string, SerializedActivation]>;
};

/**
 * Split the topologically-sorted nodes into units of execution: one unit per
 * checkpointed node, and one per contiguous run of inline-safe nodes.
 *
 * Contiguity is decided on TOPOLOGICAL position, not on reachability — which
 * nodes actually run is a runtime question (branches, skips, replay slices), and
 * a segment handles that internally. So the split is a pure function of the
 * node list, and therefore identical on every retry: the step ids it produces
 * are stable, which is what lets Inngest memoize them.
 */
function planSegments(
  sortedNodes: ExecutableNode[],
): Array<{ start: number; end: number; checkpoint: boolean }> {
  const segments: Array<{ start: number; end: number; checkpoint: boolean }> =
    [];

  for (let i = 0; i < sortedNodes.length; i++) {
    const checkpoint = requiresCheckpoint(sortedNodes[i].type as NodeType);
    const open = segments[segments.length - 1];
    const canExtend =
      open !== undefined &&
      !open.checkpoint &&
      !checkpoint &&
      open.end - open.start + 1 < MAX_SEGMENT_NODES;

    if (canExtend) open.end = i;
    else segments.push({ start: i, end: i, checkpoint });
  }

  return segments;
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
 * if it's reachable along an *active* path. A node runs when it is a **trigger**
 * (the only roots) or at least one incoming connection is active — so a node the
 * user has unwired from the flow is skipped, not fired.
 * After a node runs, its outgoing connections become active per the activation
 * rule: a non-branching node (returns a plain context) activates *all* its
 * outgoing connections — preserving the original linear behavior with no data
 * migration — while a branching node (returns `routed(context, outputs)`)
 * activates only the connections whose `fromOutput` is in `outputs`. A fan-out
 * node (returns `fanOut(context, items)`) activates *no* outgoing connections
 * in this run — the engine hands its items to the `fanOutDispatcher` to run as
 * child sub-executions, so every downstream node is recorded SKIPPED. Nodes that
 * never become reachable are skipped (and recorded as SKIPPED).
 *
 * When a `recorder` is supplied, each node emits a settle (success/fail/skip)
 * event carrying its input (incoming context), output (new-key diff), and
 * wall-clock duration — the single seam that gives per-node observability for
 * every node type without touching any executor.
 *
 * Replay-from-node: when `replayFromNodeId` is set, only that node and its
 * forward-reachable descendants run; everything upstream is treated as
 * already-run (skipped, with its output pre-seeded into the context via
 * `initialData` — the recorded `NodeExecution.input` of the replayed node). The
 * replayed node is forced reachable (a synthetic root) even though it has
 * incoming edges, then its descendants activate through the normal branch logic,
 * so branch decisions downstream are re-derived fresh against the edited config.
 */
export async function runWorkflowNodes({
  sortedNodes,
  connections = [],
  userId,
  executionId,
  initialData,
  step,
  publish,
  recorder,
  fanOutDispatcher,
  replayFromNodeId,
}: {
  sortedNodes: ExecutableNode[];
  connections?: ExecutableConnection[];
  userId: string;
  /** Execution row id, threaded to executors for deterministic resource keys. */
  executionId: string;
  initialData?: WorkflowContext;
  step: StepTools;
  publish: Realtime.PublishFn;
  recorder?: NodeRecorder;
  fanOutDispatcher?: FanOutDispatcher;
  replayFromNodeId?: string;
}): Promise<WorkflowContext> {
  let context: WorkflowContext = initialData || {};

  // Executors publish node status from the handler body, which the realtime
  // middleware would otherwise turn into one durable step per publish — two per
  // checkpointed node, for a fire-and-forget UI ping. Wrapped ONCE here so all
  // 36 executors are covered without touching any of them. See `directPublish`.
  const nodePublish = directPublish(publish);

  /**
   * Nodes that already settled in an EARLIER invocation, so their status was
   * published then and must not be published again — see `settledNodeIds`.
   *
   * Queried once per invocation, before any node runs. A node that settles
   * during THIS invocation is deliberately absent, because that is exactly when
   * its status should go out.
   */
  const alreadySettled =
    (await recorder?.settledNodeIds?.(sortedNodes.map((n) => n.id))) ??
    new Set<string>();

  /** Accepts and discards, so a replayed node's executor publishes nothing. */
  const silentPublish = (async () =>
    undefined) as unknown as Realtime.PublishFn;

  /**
   * Settled nodes waiting to be written, each stamped when the engine OBSERVED
   * it settle — not when the row is written, so a delayed flush costs nothing in
   * timestamp accuracy.
   *
   * Buffering exists because Inngest re-executes the whole handler body on every
   * step boundary, memoizing only completed steps. Writing a row from the handler
   * body therefore re-wrote it once per subsequent invocation — O(K²) round trips
   * for a K-node workflow, with `durationMs` and `completedAt` recomputed against
   * an already-memoized executor each time, which is to say against nothing.
   *
   * A step callback, by contrast, runs exactly once and is memoized thereafter.
   * So the fix is not to detect replays (there is no signal for it — the
   * invocation where a callback runs is always an abandoned one) but to write
   * from inside a step the run is already paying for.
   */
  const pending: NodeRecord[] = [];

  /**
   * Write everything buffered so far. Safe to call anywhere and any number of
   * times: the buffer is drained on the way out, and the recorder is required to
   * be idempotent for the case where a rebuilt buffer offers the same record
   * again.
   */
  const flushPending = async (): Promise<void> => {
    if (!recorder || pending.length === 0) return;
    // Drain BEFORE awaiting: nothing else runs concurrently here, but leaving
    // records in the buffer while the write is in flight would re-ship them if
    // another flush point fired first.
    const batch = pending.splice(0, pending.length);
    await recorder.flush(batch);
  };

  // Replay slice: the set of nodes that actually run this time. Nodes outside it
  // are recorded SKIPPED (their output already lives in the seeded context).
  const replaySlice = replayFromNodeId
    ? forwardReachableFrom(replayFromNodeId, connections)
    : null;

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

  /**
   * Run ONE node: reachability, execution, branch activation, recording.
   *
   * Extracted from the loop so a node behaves identically whether it is running
   * as its own checkpointed step or inline inside a batched segment — the only
   * difference is which `nodeStep` it is handed. Writing it once is what keeps
   * the two paths from drifting.
   *
   * Mutates `context` and `activationByNode` in the enclosing scope. Inside a
   * segment those mutations are captured into the `SegmentResult` the step
   * returns, because on a replay this function never runs at all.
   */
  const runNode = async (
    node: ExecutableNode,
    sequence: number,
    nodeStep: ExecutorStep,
    inline: boolean,
  ): Promise<void> => {
    const before = context;
    const base = {
      nodeId: node.id,
      nodeType: node.type as NodeType,
      nodeName: node.name,
      sequence,
      input: before,
    };

    // Replay: a node outside the replay slice already ran upstream — skip it
    // (its output is in the seeded context). Checked before reachability so the
    // original trigger/roots don't re-fire on a replay.
    if (replaySlice && !replaySlice.has(node.id)) {
      pending.push({
        ...base,
        status: "SKIPPED",
        durationMs: 0,
        completedAt: new Date(),
      });
      return;
    }

    // Reachability: **triggers** are the only roots — they always run. Every
    // other node needs at least one active incoming edge, so anything the user
    // has unwired from the flow is skipped rather than fired. On a replay the
    // node we replay from is a forced root — it runs fresh against the seeded
    // context even though its real incoming edges' sources were skipped.
    //
    // This used to read `incoming.length === 0`, i.e. ANY node with no incoming
    // edges was a root. That was right for triggers and wrong for everything
    // else: deleting a node's last incoming wire promoted it to a root, so it
    // still ran (and activated its own downstream, keeping a whole severed chain
    // alive). Deleting an edge therefore didn't stop anything from running.
    const incoming = incomingByNode.get(node.id) ?? [];
    const reachable =
      node.id === replayFromNodeId ||
      TRIGGER_NODE_TYPES.has(node.type) ||
      incoming.some(isEdgeActive);

    if (!reachable) {
      pending.push({
        ...base,
        status: "SKIPPED",
        durationMs: 0,
        completedAt: new Date(),
      });
      return;
    }

    const executor = getExecutor(node.type as NodeType);

    // The stable key this node writes its output under; passed to the executor
    // and (on fan-out) to the dispatcher so the per-item seed overwrites the
    // node's own summary output under the same key.
    const outputKey = getOutputKeyForNode(node.type, node.id, node.ref);

    // Wall-clock around the executor: includes Inngest step/checkpoint and any
    // network overhead, so it's "elapsed time" rather than precise compute.
    const startedAt = Date.now();
    try {
      const result = await executor({
        data: node.data as Record<string, unknown>,
        nodeId: node.id,
        outputKey,
        executionId,
        userId,
        context: before,
        step: nodeStep,
        publish: alreadySettled.has(node.id) ? silentPublish : nodePublish,
      });

      // Fan-out: dispatch one child sub-execution per item and activate no
      // outgoing edge in this run — so every downstream node is recorded
      // SKIPPED by the existing reachability logic. The node's own summary
      // output already lives in `after`.
      if (isFanOut(result)) {
        const after = result.context;
        activationByNode.set(node.id, { all: false, outputs: new Set() });

        // NonRetriableError, not Error: both guards below describe a WIRING
        // fault, which no retry can resolve. A plain Error costs three full
        // re-runs of the batch — including the network reads of every node in
        // it — before the run finally fails with the same message.
        if (!fanOutDispatcher) {
          throw new NonRetriableError(
            `Node ${node.id} (${node.type}) returned a fan-out result but no ` +
              "fanOutDispatcher was wired into runWorkflowNodes — this is a bug.",
          );
        }

        // Dispatching sends events, which Inngest forbids from inside a step —
        // and the dispatcher checkpoints its sends so a retry re-emits every
        // item. Neither works within a batched segment. Today this is
        // unreachable: `fanOut(...)` comes only from `applyMultiMatchPolicy`,
        // used only by GOOGLE_SHEETS_ACTION, which is checkpointed. It is a
        // guard against a FUTURE fan-out node being classified inline-safe,
        // where the failure would otherwise be a silently dropped fan-out.
        if (inline) {
          throw new NonRetriableError(
            `Node ${node.id} (${node.type}) fanned out from inside a batched ` +
              "segment, which cannot dispatch child runs. Mark this node type " +
              "`true` in CHECKPOINTED_NODE_TYPES (src/config/node-kinds.ts).",
          );
        }

        // Dispatch BEFORE recording SUCCESS so a dispatch failure is caught
        // below and the node is recorded FAILED (and the run fails) instead of
        // being falsely marked successful with its children never sent.
        await fanOutDispatcher.dispatch({
          nodeId: node.id,
          outputKey,
          context: after,
          items: result.items,
        });

        pending.push({
          ...base,
          status: "SUCCESS",
          output: newKeysDiff(before, after),
          durationMs: Date.now() - startedAt,
          completedAt: new Date(),
        });

        context = after;
        return;
      }

      // Normalize the executor return into (next context, activated outputs).
      // Plain context => non-branching => activate all outgoing edges.
      const after = isRouted(result) ? result.context : result;
      activationByNode.set(
        node.id,
        isRouted(result)
          ? { all: false, outputs: new Set(result.outputs) }
          : { all: true, outputs: new Set() },
      );

      pending.push({
        ...base,
        status: "SUCCESS",
        output: newKeysDiff(before, after),
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
      });

      context = after;
    } catch (error) {
      pending.push({
        ...base,
        status: "FAILED",
        error,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
      });
      // Flush IMMEDIATELY rather than waiting for a later step callback: this
      // node's throw ends the run, so there is no later step to ride on. Bounded
      // to once per attempt for the same reason, which is why writing from the
      // handler body is affordable here and not on the success path.
      //
      // Swallowed deliberately, and ONLY here. If this write rejects — a Prisma
      // pool timeout, a connection blip — an unguarded `await` would replace the
      // node's real error with the database's on its way out. The run would then
      // report "Timed out fetching a new connection" for what was actually a
      // Calculator divide-by-zero, and with no FAILED row written,
      // `resolveFailureCause` would additionally see zero records and prepend
      // "cause unknown". Losing the record is bad; losing the diagnosis is worse.
      // The other flush points stay unguarded — their throws are legitimately
      // retryable.
      try {
        await flushPending();
      } catch (flushError) {
        logger.error("Failed to record a failed node", flushError);
      }
      throw error;
    }
  };

  // Execute the plan: a checkpointed node runs directly against Inngest's real
  // `step` — so the read/write splits inside its executor stay real, separately
  // memoized steps — while a run of inline-safe nodes shares ONE step.
  for (const segment of planSegments(sortedNodes)) {
    if (segment.checkpoint) {
      // Hand the node a step that flushes the buffer inside each callback. That
      // callback runs exactly once and is memoized thereafter, so every buffered
      // row is written once, at no extra step. Flushing BEFORE the callback's own
      // work means a node that throws still persists its predecessors.
      await runNode(
        sortedNodes[segment.start],
        segment.start,
        flushingStep(step, flushPending),
        false,
      );
      continue;
    }

    // The step id is derived from topological POSITION, which `planSegments`
    // computes identically on every attempt — so a retry addresses the same
    // step and Inngest can memoize it.
    const result = (await step.run(
      `nodes:${segment.start}-${segment.end}`,
      async (): Promise<SegmentResult> => {
        // Anything settled before this segment rides in on the step we are
        // already paying for.
        await flushPending();

        for (let i = segment.start; i <= segment.end; i++) {
          await runNode(sortedNodes[i], i, inlineStep, true);
        }

        // The segment's OWN nodes, written inside the segment's step so they
        // are memoized with it. Without this they would wait for the next
        // checkpointed node, which may be a whole segment away.
        await flushPending();

        // Only this segment's nodes: earlier activations are already applied
        // below, and re-returning them would grow the payload quadratically.
        // A skipped node has no entry, and `isEdgeActive` reads a missing one
        // as inactive — which is exactly right.
        const activations: Array<[string, SerializedActivation]> = [];
        for (let i = segment.start; i <= segment.end; i++) {
          const activation = activationByNode.get(sortedNodes[i].id);
          if (activation) {
            activations.push([
              sortedNodes[i].id,
              { all: activation.all, outputs: [...activation.outputs] },
            ]);
          }
        }

        return { context, activations };
      },
    )) as SegmentResult;

    // Re-seed from the RETURNED value rather than trusting the mutations above:
    // on a replay the body never ran, so the closure state is untouched and this
    // is the only place the segment's effect exists.
    context = result.context;
    for (const [nodeId, activation] of result.activations) {
      activationByNode.set(nodeId, {
        all: activation.all,
        outputs: new Set(activation.outputs),
      });
    }
  }

  // The tail: nodes that settled after the last step callback. This runs in the
  // handler body, so it repeats on the one or two invocations where the loop
  // completes — bounded, and the recorder skips rows already written, so the
  // repeat costs a lookup rather than a write.
  await flushPending();

  return context;
}
