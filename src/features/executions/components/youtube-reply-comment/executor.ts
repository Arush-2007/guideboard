import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import type { NodeExecutor } from "@/features/executions/types";
import { youtubeReplyChannel } from "@/inngest/channels/youtube-reply-comment";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  return new Handlebars.SafeString(JSON.stringify(context, null, 2));
});

type YoutubeReplyData = {
  variableName?: string;
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
    youtubeReplyChannel().status({
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
    await publish(youtubeReplyChannel().status({ nodeId, status: "error" }));
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const rawReply = Handlebars.compile(config.replyMessage)(context);
  const compiledReply = decode(rawReply);

  try {
    const result = await step.run("youtube-reply", async () => {
      const commentId = context.commentId as string | undefined;
      if (!commentId) {
        await publish(
          youtubeReplyChannel().status({ nodeId, status: "error" }),
        );
        throw new NonRetriableError(
          "YouTube Reply node: commentId is missing from workflow context",
        );
      }

      const accessToken = await refreshYoutubeTokenIfNeeded(userId);

      await ky
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
        })
        .json<YoutubeCommentResponse>();

      if (!config.variableName) {
        await publish(
          youtubeReplyChannel().status({ nodeId, status: "error" }),
        );
        throw new NonRetriableError(
          "YouTube Reply node: Variable name is missing",
        );
      }

      return {
        ...context,
        [config.variableName]: {
          replyText: compiledReply,
        },
      };
    });

    await publish(
      youtubeReplyChannel().status({ nodeId, status: "success" }),
    );

    return result;
  } catch (error) {
    await publish(
      youtubeReplyChannel().status({ nodeId, status: "error" }),
    );
    throw error;
  }
};
