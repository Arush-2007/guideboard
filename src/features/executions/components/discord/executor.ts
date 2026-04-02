import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import type { NodeExecutor } from "@/features/executions/types";
import { discordChannel } from "@/inngest/channels/discord";
import ky from "ky";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type DiscordData = {
  variableName?: string;
  webhookUrl?: string;
  content?: string;
  username?: string;
};

export const discordExecutor: NodeExecutor<DiscordData> = async ({
  data,
  nodeId,
  context,
  step,
  publish,
}) => {
  await publish(
    discordChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: DiscordData;
  try {
    config = parseNodeConfig(NodeType.DISCORD, data) as DiscordData;
  } catch (error) {
    await publish(
      discordChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const rawContent = Handlebars.compile(config.content)(context);
  const content = decode(rawContent);
  const username = config.username
    ? decode(Handlebars.compile(config.username)(context))
    : undefined;

  try {
    const result = await step.run("discord-webhook", async () => {
      if (!config.webhookUrl) {
        await publish(
          discordChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("Discord node: Webhook URL is required");
      }

      await ky.post(config.webhookUrl as string, {
        json: {
          content: content.slice(0, 2000), // Discord's max message length
          username,
        },
      });

      if (!config.variableName) {
        await publish(
          discordChannel().status({
            nodeId,
            status: "error",
          })
        );
        throw new NonRetriableError("Discord node: Variable name is missing");
      }

      return {
        ...context,
        [config.variableName]: {
          messageContent: content.slice(0, 2000),
        },
      };
    });
    
    await publish(
      discordChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
     await publish(
      discordChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
