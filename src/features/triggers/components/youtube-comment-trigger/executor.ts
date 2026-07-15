import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";

type YoutubeCommentTriggerData = Record<string, unknown>;

export const youtubeCommentTriggerExecutor: NodeExecutor<
  YoutubeCommentTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.YOUTUBE_COMMENT_TRIGGER, data);
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const result = await step.run("youtube-comment-trigger", async () => context);

  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
