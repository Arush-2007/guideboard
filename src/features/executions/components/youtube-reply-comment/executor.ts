import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { renderTemplate } from "@/lib/templating";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";

type YoutubeReplyData = {
  replyMessage?: string;
};

type YoutubeCommentResponse = {
  id: string;
};

export const youtubeReplyExecutor: NodeExecutor<YoutubeReplyData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: YoutubeReplyData;
  try {
    config = parseNodeConfig(
      NodeType.YOUTUBE_REPLY_COMMENT,
      data,
    ) as YoutubeReplyData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const rawReply = renderTemplate(config.replyMessage, context);
  const compiledReply = decode(rawReply);

  try {
    const result = await step.run("youtube-reply", async () => {
      const commentId = context.commentId as string | undefined;
      if (!commentId) {
        await publish(
          nodeStatusChannel(userId).status({ nodeId, status: "error" }),
        );
        throw new NonRetriableError(
          "YouTube Reply node: commentId is missing from workflow context",
        );
      }

      const accessToken = await refreshYoutubeTokenIfNeeded(userId);

      await http
        .post("https://www.googleapis.com/youtube/v3/comments", {
          searchParams: { part: "snippet" },
          json: {
            snippet: {
              parentId: commentId,
              textOriginal: compiledReply,
            },
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: HTTP_TIMEOUT.WRITE,
        })
        .json<YoutubeCommentResponse>()
        .catch(
          rethrowTimeout({
            integration: "YouTube",
            timeoutClass: "WRITE",
            // A retry would post the reply a SECOND time.
            idempotent: false,
            hint: "The reply may or may not have posted — check the comment before re-running.",
          }),
        );

      const prevAi = context.aiReply;
      const mergedAi =
        typeof prevAi === "object" && prevAi !== null && !Array.isArray(prevAi)
          ? {
              ...(prevAi as Record<string, unknown>),
              replyText: compiledReply,
            }
          : { replyText: compiledReply };

      return {
        ...context,
        aiReply: mergedAi,
      };
    });

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );

    return result;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw error;
  }
};
