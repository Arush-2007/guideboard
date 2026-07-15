import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { renderTemplate } from "@/lib/templating";

type DiscordData = {
  webhookUrl?: string;
  content?: string;
  username?: string;
};

export const discordExecutor: NodeExecutor<DiscordData> = async ({
  data,
  nodeId,
  outputKey,
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

  let config: DiscordData;
  try {
    config = parseNodeConfig(NodeType.DISCORD, data) as DiscordData;
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

  const rawContent = renderTemplate(config.content, context);
  const content = decode(rawContent);
  const username = config.username
    ? decode(renderTemplate(config.username, context))
    : undefined;
  try {
    const result = await step.run("discord-webhook", async () => {
      if (!config.webhookUrl) {
        await publish(
          nodeStatusChannel(userId).status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("Discord node: Webhook URL is required");
      }

      await http
        .post(config.webhookUrl as string, {
          json: {
            content: content.slice(0, 2000), // Discord's max message length
            username,
          },
          timeout: HTTP_TIMEOUT.WRITE,
        })
        .catch(
          rethrowTimeout({
            integration: "Discord",
            timeoutClass: "WRITE",
            // A retry would post the message a SECOND time.
            idempotent: false,
            hint: "The message may already have been sent — check before re-running.",
          }),
        );

      return {
        ...context,
        [outputKey]: {
          messageContent: content.slice(0, 2000),
        },
      };
    });

    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
