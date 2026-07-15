import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { renderTemplate } from "@/lib/templating";

type SlackData = {
  webhookUrls?: string[];
  /** Legacy single-webhook field. */
  webhookUrl?: string;
  content?: string;
};

export const slackExecutor: NodeExecutor<SlackData> = async ({
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

  let config: SlackData;
  try {
    config = parseNodeConfig(NodeType.SLACK, data) as SlackData;
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
  // Combine the fan-out list with the legacy single field, de-duplicated.
  const webhookUrls = [
    ...(Array.isArray(config.webhookUrls) ? config.webhookUrls : []),
    ...(config.webhookUrl ? [config.webhookUrl] : []),
  ]
    .map((u) => u.trim())
    .filter(Boolean);
  const uniqueUrls = [...new Set(webhookUrls)];

  try {
    const result = await step.run("slack-webhook", async () => {
      if (uniqueUrls.length === 0) {
        throw new NonRetriableError(
          "Slack node: at least one webhook URL is required",
        );
      }

      // Slack Incoming Webhooks expect a `text` field. Post to every channel.
      // These run concurrently, so the step's cost is ONE write timeout, not N.
      await Promise.all(
        uniqueUrls.map((url) =>
          http
            .post(url, {
              json: { text: content },
              timeout: HTTP_TIMEOUT.WRITE,
            })
            .catch(
              rethrowTimeout({
                integration: "Slack",
                timeoutClass: "WRITE",
                // A retry would post the message a SECOND time.
                idempotent: false,
                hint: "The message may already have been sent — check before re-running.",
              }),
            ),
        ),
      );

      return {
        ...context,
        [outputKey]: {
          messageContent: content.slice(0, 2000),
          deliveredCount: uniqueUrls.length,
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
