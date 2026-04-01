import type { NodeExecutor } from "@/features/executions/types";
import { youtubeCommentTriggerChannel } from "@/inngest/channels/youtube-comment-trigger";

type YoutubeCommentTriggerData = Record<string, unknown>;

export const youtubeCommentTriggerExecutor: NodeExecutor<YoutubeCommentTriggerData> =
  async ({ nodeId, context, step, publish }) => {
    await publish(
      youtubeCommentTriggerChannel().status({
        nodeId,
        status: "loading",
      }),
    );

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
