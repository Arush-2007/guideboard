import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { renderTemplate } from "@/lib/templating";

type TelegramActionData = {
  credentialId?: string;
  chatId?: string;
  message?: string;
};

const TELEGRAM_MAX_MESSAGE = 4096;

export const telegramActionExecutor: NodeExecutor<TelegramActionData> = async ({
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

  let config: TelegramActionData;
  try {
    config = parseNodeConfig(
      NodeType.TELEGRAM_ACTION,
      data,
    ) as TelegramActionData;
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

  const credential = await step.run("get-telegram-credential", () => {
    return prisma.credential.findUnique({
      where: {
        id: config.credentialId,
        userId,
      },
    });
  });

  if (!credential || credential.type !== CredentialType.TELEGRAM) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      "Telegram node: Telegram credential not found or wrong type",
    );
  }

  let botToken: string;
  try {
    botToken = decrypt(credential.value).trim();
  } catch {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("Telegram node: Failed to read bot token");
  }

  if (!botToken) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("Telegram node: Bot token is empty");
  }

  const rawChatId = renderTemplate(config.chatId ?? "", context);
  const chatId = decode(rawChatId).trim();
  const rawMessage = renderTemplate(config.message ?? "", context);
  const text = decode(rawMessage).slice(0, TELEGRAM_MAX_MESSAGE);
  try {
    const result = await step.run("telegram-send-message", async () => {
      if (!chatId) {
        throw new NonRetriableError("Telegram node: Chat ID is required");
      }
      if (!text) {
        throw new NonRetriableError("Telegram node: Message is required");
      }

      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await http
        .post(url, {
          json: {
            chat_id: chatId,
            text,
          },
          timeout: HTTP_TIMEOUT.WRITE,
        })
        .catch(
          rethrowTimeout({
            integration: "Telegram",
            timeoutClass: "WRITE",
            // A retry would post the message a SECOND time.
            idempotent: false,
            hint: "The message may already have been sent — check before re-running.",
          }),
        );

      return {
        ...context,
        [outputKey]: {
          text,
          chatId,
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
