import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import type { NodeExecutor } from "@/features/executions/types";
import { youtubeReplyChannel } from "@/inngest/channels/youtube-reply-comment";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";

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

  if (!data.replyMessage) {
    await publish(
      youtubeReplyChannel().status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      "YouTube Reply node: Reply message is required",
    );
  }

  const rawReply = Handlebars.compile(data.replyMessage)(context);
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

      if (!data.variableName) {
        await publish(
          youtubeReplyChannel().status({ nodeId, status: "error" }),
        );
        throw new NonRetriableError(
          "YouTube Reply node: Variable name is missing",
        );
      }

      return {
        ...context,
        [data.variableName]: {
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
