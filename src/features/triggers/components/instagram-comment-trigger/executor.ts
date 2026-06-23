import type { NodeExecutor } from "@/features/executions/types";
import { instagramCommentTriggerChannel } from "@/inngest/channels/instagram-comment-trigger";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type InstagramCommentTriggerData = Record<string, unknown>;

export const instagramCommentTriggerExecutor: NodeExecutor<
  InstagramCommentTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    instagramCommentTriggerChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.INSTAGRAM_COMMENT_TRIGGER, data);
  } catch (error) {
    await publish(
      instagramCommentTriggerChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const result = await step.run(
    "instagram-comment-trigger",
    async () => context,
  );

  await publish(
    instagramCommentTriggerChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
