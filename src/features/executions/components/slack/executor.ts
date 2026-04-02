import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import type { NodeExecutor } from "@/features/executions/types";
import { slackChannel } from "@/inngest/channels/slack";
import ky from "ky";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type SlackData = {
  variableName?: string;
  webhookUrl?: string;
  content?: string;
};

export const slackExecutor: NodeExecutor<SlackData> = async ({
  data,
  nodeId,
  context,
  step,
  publish,
}) => {
  await publish(
    slackChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: SlackData;
  try {
    config = parseNodeConfig(NodeType.SLACK, data) as SlackData;
  } catch (error) {
    await publish(
      slackChannel().status({
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

  try {
    const result = await step.run("slack-webhook", async () => {
      if (!config.webhookUrl) {
        await publish(
          slackChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("Slack node: Webhook URL is required");
      }

      await ky.post(config.webhookUrl, {
        json: {
          content: content, // The key depends on workflow config
        },
      });

      if (!config.variableName) {
        await publish(
          slackChannel().status({
            nodeId,
            status: "error",
          })
        );
        throw new NonRetriableError("Slack node: Variable name is missing");
      }

      return {
        ...context,
        [config.variableName]: {
          messageContent: content.slice(0, 2000),
        },
      };
    });
    
    await publish(
      slackChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
     await publish(
      slackChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
