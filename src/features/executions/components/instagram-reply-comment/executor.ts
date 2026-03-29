import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import type { NodeExecutor } from "@/features/executions/types";
import { instagramReplyChannel } from "@/inngest/channels/instagram-reply-comment";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";

Handlebars.registerHelper("json", (context) => {
  return new Handlebars.SafeString(JSON.stringify(context, null, 2));
});

type InstagramReplyData = {
  variableName?: string;
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

  if (!data.replyMessage) {
    await publish(
      instagramReplyChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      "Instagram Reply node: Reply message is required",
    );
  }

  const rawReply = Handlebars.compile(data.replyMessage)(context);
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

      await ky.post(
        `https://graph.instagram.com/v21.0/${commentId}/replies`,
        {
          searchParams: { access_token: accessToken },
          json: { message: compiledReply },
        },
      ).json<InstagramReplyResponse>();

      if (!data.variableName) {
        await publish(
          instagramReplyChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError(
          "Instagram Reply node: Variable name is missing",
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
