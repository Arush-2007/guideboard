import type { NodeStatus } from "@/components/react-flow/node-status-indicator";

/**
 * Minimal shape of an Inngest realtime message we read for node status.
 * Kept permissive on purpose: `useInngestSubscription` returns a per-channel
 * union type, but every "status" topic publishes the same { nodeId, status }
 * payload, so we narrow defensively at runtime.
 */
export interface StatusMessageLike {
  kind?: string;
  topic?: string;
  channel?: string;
  createdAt?: string | Date;
  data?: unknown;
}

/**
 * Distinct, sorted list of realtime channels needed for the given node types.
 * `channelOf` resolves a node type to its channel name (or undefined for types
 * with no status channel, e.g. INITIAL).
 *
 * The result is sorted so its contents are stable for a given *set* of types —
 * callers memoize on a type-set signature so the subscriber list only changes
 * when the set of node types changes, not on every node drag.
 */
export function deriveActiveChannels(
  nodeTypes: Iterable<string | null | undefined>,
  channelOf: (type: string) => string | undefined,
): string[] {
  const channels = new Set<string>();
  for (const type of nodeTypes) {
    if (!type) continue;
    const channelName = channelOf(type);
    if (channelName) channels.add(channelName);
  }
  return [...channels].sort();
}

/**
 * Folds a batch of realtime messages into a *delta* map of nodeId -> latest
 * status. "Latest" is decided by `createdAt` (ties resolve to the later array
 * position, mirroring the previous per-node sort-desc-take-first behavior).
 *
 * Callers MUST merge this delta into the shared status map (never replace it),
 * so nodes absent from the current batch keep their existing status instead of
 * resetting to "initial".
 */
export function reduceLatestStatuses(
  messages: readonly StatusMessageLike[],
): Record<string, NodeStatus> {
  const latest: Record<string, { status: NodeStatus; at: number }> = {};

  for (const message of messages) {
    if (message.kind !== "data") continue;
    if (message.topic !== "status") continue;

    const data = message.data as
      | { nodeId?: unknown; status?: unknown }
      | undefined;
    const nodeId = data?.nodeId;
    const status = data?.status;
    if (typeof nodeId !== "string") continue;
    if (typeof status !== "string") continue;

    const at = message.createdAt ? new Date(message.createdAt).getTime() : 0;
    const existing = latest[nodeId];
    if (!existing || at >= existing.at) {
      latest[nodeId] = { status: status as NodeStatus, at };
    }
  }

  const result: Record<string, NodeStatus> = {};
  for (const nodeId of Object.keys(latest)) {
    result[nodeId] = latest[nodeId].status;
  }
  return result;
}
