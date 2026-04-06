import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import type { NodeExecutor } from "@/features/executions/types";
import { telegramActionChannel } from "@/inngest/channels/telegram-action";
import ky from "ky";
import { CredentialType, NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  return new Handlebars.SafeString(jsonString);
});

type TelegramActionData = {
  credentialId?: string;
  chatId?: string;
  message?: string;
};

const TELEGRAM_MAX_MESSAGE = 4096;

export const telegramActionExecutor: NodeExecutor<TelegramActionData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    telegramActionChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: TelegramActionData;
  try {
    config = parseNodeConfig(NodeType.TELEGRAM_ACTION, data) as TelegramActionData;
  } catch (error) {
    await publish(
      telegramActionChannel().status({
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
      telegramActionChannel().status({
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
      telegramActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("Telegram node: Failed to read bot token");
  }

  if (!botToken) {
    await publish(
      telegramActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("Telegram node: Bot token is empty");
  }

  const rawChatId = Handlebars.compile(config.chatId ?? "")(context);
  const chatId = decode(rawChatId).trim();
  const rawMessage = Handlebars.compile(config.message ?? "")(context);
  const text = decode(rawMessage).slice(0, TELEGRAM_MAX_MESSAGE);
  const outputKey = `${NodeType.TELEGRAM_ACTION.toLowerCase()}_${nodeId}`;

  try {
    const result = await step.run("telegram-send-message", async () => {
      if (!chatId) {
        throw new NonRetriableError("Telegram node: Chat ID is required");
      }
      if (!text) {
        throw new NonRetriableError("Telegram node: Message is required");
      }

      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await ky.post(url, {
        json: {
          chat_id: chatId,
          text,
        },
      });

      return {
        ...context,
        [outputKey]: {
          text,
          chatId,
        },
      };
    });

    await publish(
      telegramActionChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      telegramActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
