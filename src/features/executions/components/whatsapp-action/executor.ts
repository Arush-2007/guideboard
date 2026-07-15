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

type WhatsappCredentialValue = {
  accessToken?: string;
  phoneNumberId?: string;
};

type WhatsappActionData = {
  recipientPhones?: string[];
  /** Legacy single-recipient field. */
  recipientPhone?: string;
  message?: string;
};

export const whatsappActionExecutor: NodeExecutor<WhatsappActionData> = async ({
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

  let config: WhatsappActionData;
  try {
    config = parseNodeConfig(
      NodeType.WHATSAPP_ACTION,
      data,
    ) as WhatsappActionData;
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

  // Combine the fan-out list with the legacy single field; render each phone
  // template against the context, trim, drop blanks, de-duplicate.
  const phoneTemplates = [
    ...(Array.isArray(config.recipientPhones) ? config.recipientPhones : []),
    ...(config.recipientPhone ? [config.recipientPhone] : []),
  ];
  const recipientPhones = [
    ...new Set(
      phoneTemplates
        .map((tpl) => decode(renderTemplate(tpl, context)).trim())
        .filter(Boolean),
    ),
  ];

  const rawMessage = renderTemplate(config.message ?? "", context);
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
      nodeStatusChannel(userId).status({
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
      nodeStatusChannel(userId).status({
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
      nodeStatusChannel(userId).status({
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
      if (recipientPhones.length === 0) {
        throw new NonRetriableError(
          "WhatsApp node: at least one recipient is required",
        );
      }
      if (!compiledMessage.trim()) {
        throw new NonRetriableError("WhatsApp node: Message is required");
      }

      // Concurrent, so the step's cost is ONE write timeout, not one per recipient.
      await Promise.all(
        recipientPhones.map((to) =>
          http
            .post(
              `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
                json: {
                  messaging_product: "whatsapp",
                  to,
                  type: "text",
                  text: {
                    body: compiledMessage,
                  },
                },
                timeout: HTTP_TIMEOUT.WRITE,
              },
            )
            .catch(
              rethrowTimeout({
                integration: "WhatsApp",
                timeoutClass: "WRITE",
                // A retry would message the recipients a SECOND time.
                idempotent: false,
                hint: "Some recipients may already have received the message — check before re-running.",
              }),
            ),
        ),
      );

      return {
        ...context,
        [outputKey]: {
          recipientPhones: recipientPhones.join(", "),
          message: compiledMessage,
          deliveredCount: recipientPhones.length,
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
