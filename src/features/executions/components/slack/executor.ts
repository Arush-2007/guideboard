import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { slackChannel } from "@/inngest/channels/slack";
import { renderTemplate } from "@/lib/templating";

type SlackData = {
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

  const rawContent = renderTemplate(config.content, context);
  const content = decode(rawContent);
  const outputKey = `${NodeType.SLACK.toLowerCase()}_${nodeId}`;

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

      return {
        ...context,
        [outputKey]: {
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
