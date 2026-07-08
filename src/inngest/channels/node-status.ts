import { channel, topic } from "@inngest/realtime";

export const NODE_STATUS_CHANNEL_NAME = "node-status";

// One per-user channel carrying the status of EVERY node type
// (`node-status:<userId>`), so the editor opens a single realtime subscription
// regardless of how many distinct node types are on the canvas. Publish with
// `nodeStatusChannel(userId)`; tokens are minted for the session user via
// mintUserStatusToken. Replaces the former per-node-type channel fan-out.
export const nodeStatusChannel = channel(
  (userId: string) => `${NODE_STATUS_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
