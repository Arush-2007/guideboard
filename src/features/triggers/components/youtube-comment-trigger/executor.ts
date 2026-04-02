import type { NodeExecutor } from "@/features/executions/types";
import { youtubeCommentTriggerChannel } from "@/inngest/channels/youtube-comment-trigger";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type YoutubeCommentTriggerData = Record<string, unknown>;

export const youtubeCommentTriggerExecutor: NodeExecutor<YoutubeCommentTriggerData> =
  async ({ nodeId, context, step, publish, data }) => {
    await publish(
      youtubeCommentTriggerChannel().status({
        nodeId,
        status: "loading",
      }),
    );

    try {
      parseNodeConfig(NodeType.YOUTUBE_COMMENT_TRIGGER, data);
    } catch (error) {
      await publish(
        youtubeCommentTriggerChannel().status({
          nodeId,
          status: "error",
        }),
      );
      throw new NonRetriableError(
        error instanceof Error ? error.message : "Invalid node config",
      );
    }

    const result = await step.run(
      "youtube-comment-trigger",
      async () => context,
    );

    await publish(
      youtubeCommentTriggerChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  };
