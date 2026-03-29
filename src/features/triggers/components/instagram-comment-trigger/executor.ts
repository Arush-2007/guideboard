import type { NodeExecutor } from "@/features/executions/types";
import { instagramCommentTriggerChannel } from "@/inngest/channels/instagram-comment-trigger";

type InstagramCommentTriggerData = Record<string, unknown>;

export const instagramCommentTriggerExecutor: NodeExecutor<InstagramCommentTriggerData> =
  async ({ nodeId, context, step, publish }) => {
    await publish(
      instagramCommentTriggerChannel().status({
        nodeId,
        status: "loading",
      }),
    );

    const result = await step.run(
      "instagram-comment-trigger",
      async () => context,
    );

    await publish(
      instagramCommentTriggerChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  };
