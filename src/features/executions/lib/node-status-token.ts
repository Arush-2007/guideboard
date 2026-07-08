"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { nodeStatusChannel } from "@/inngest/channels/node-status";

/**
 * Mints a session-scoped subscription token for the single unified node-status
 * channel. One action serves every node type (the per-node `fetch*RealtimeToken`
 * actions are gone), driven from `node-status-registry.ts`.
 */
export async function fetchNodeStatusRealtimeToken() {
  return mintUserStatusToken(nodeStatusChannel);
}
