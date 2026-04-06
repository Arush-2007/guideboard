import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import type { NodeExecutor } from "@/features/executions/types";
import { whatsappActionChannel } from "@/inngest/channels/whatsapp-action";
import ky from "ky";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { CredentialType, NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type WhatsappCredentialValue = {
  accessToken?: string;
  phoneNumberId?: string;
};

type WhatsappActionData = {
  recipientPhone?: string;
  message?: string;
};

export const whatsappActionExecutor: NodeExecutor<WhatsappActionData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    whatsappActionChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: WhatsappActionData;
  try {
    config = parseNodeConfig(NodeType.WHATSAPP_ACTION, data) as WhatsappActionData;
  } catch (error) {
    await publish(
      whatsappActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const outputKey = `${NodeType.WHATSAPP_ACTION.toLowerCase()}_${nodeId}`;
  const rawRecipientPhone = Handlebars.compile(config.recipientPhone ?? "")(context);
  const recipientPhone = decode(rawRecipientPhone).trim();
  const rawMessage = Handlebars.compile(config.message ?? "")(context);
  const compiledMessage = decode(rawMessage);

  const credential = await step.run("get-whatsapp-credential", () => {
    return prisma.credential.findFirst({
      where: {
        userId,
        type: CredentialType.WHATSAPP,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
  });

  if (!credential) {
    await publish(
      whatsappActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("WhatsApp node: Credential not found");
  }

  let parsed: WhatsappCredentialValue;
  try {
    parsed = JSON.parse(decrypt(credential.value)) as WhatsappCredentialValue;
  } catch {
    await publish(
      whatsappActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      "WhatsApp node: Credential value must be JSON with accessToken and phoneNumberId",
    );
  }

  const accessToken = parsed.accessToken?.trim();
  const phoneNumberId = parsed.phoneNumberId?.trim();

  if (!accessToken || !phoneNumberId) {
    await publish(
      whatsappActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      "WhatsApp node: accessToken and phoneNumberId are required in credential JSON",
    );
  }

  try {
    const result = await step.run("whatsapp-send-message", async () => {
      if (!recipientPhone) {
        throw new NonRetriableError("WhatsApp node: Recipient phone is required");
      }
      if (!compiledMessage.trim()) {
        throw new NonRetriableError("WhatsApp node: Message is required");
      }

      await ky.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          json: {
            messaging_product: "whatsapp",
            to: recipientPhone,
            type: "text",
            text: {
              body: compiledMessage,
            },
          },
        },
      );

      return {
        ...context,
        [outputKey]: {
          recipientPhone,
          message: compiledMessage,
        },
      };
    });

    await publish(
      whatsappActionChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      whatsappActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
