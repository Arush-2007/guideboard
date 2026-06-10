import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { instagramReplyChannel } from "@/inngest/channels/instagram-reply-comment";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { renderTemplate } from "@/lib/templating";

type InstagramReplyData = {
  replyMessage?: string;
};

type InstagramReplyResponse = {
  id: string;
};

export const instagramReplyExecutor: NodeExecutor<InstagramReplyData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    instagramReplyChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: InstagramReplyData;
  try {
    config = parseNodeConfig(
      NodeType.INSTAGRAM_REPLY_COMMENT,
      data,
    ) as InstagramReplyData;
  } catch (error) {
    await publish(
      instagramReplyChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const rawReply = renderTemplate(config.replyMessage, context);
  const compiledReply = decode(rawReply);

  try {
    const result = await step.run("instagram-reply", async () => {
      const commentId = context.commentId as string | undefined;
      if (!commentId) {
        await publish(
          instagramReplyChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError(
          "Instagram Reply node: commentId is missing from workflow context",
        );
      }

      const credential = await prisma.instagramCredential.findFirst({
        where: { userId },
      });

      if (!credential) {
        await publish(
          instagramReplyChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError(
          "Instagram Reply node: No connected Instagram account found. Connect your Instagram account in Credentials.",
        );
      }

      // accessToken is stored as encrypt(rawToken) — decrypt gives the raw long-lived token
      const accessToken = decrypt(credential.accessToken);

      await ky
        .post(`https://graph.instagram.com/v21.0/${commentId}/replies`, {
          searchParams: { access_token: accessToken },
          json: { message: compiledReply },
        })
        .json<InstagramReplyResponse>();

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
      instagramReplyChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      instagramReplyChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
