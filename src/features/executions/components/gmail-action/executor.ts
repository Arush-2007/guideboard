import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { gmailActionChannel } from "@/inngest/channels/gmail-action";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { renderTemplate } from "@/lib/templating";

type GmailActionData = {
  to?: string | string[];
  subject?: string;
  body?: string;
};

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const gmailActionExecutor: NodeExecutor<GmailActionData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    gmailActionChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: GmailActionData;
  try {
    config = parseNodeConfig(NodeType.GMAIL_ACTION, data) as GmailActionData;
  } catch (error) {
    await publish(
      gmailActionChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  // `to` may be an array of recipient templates (new) or a single string
  // (legacy). Render each, drop blanks, and join into one RFC 2822 To header.
  const recipientTemplates = Array.isArray(config.to)
    ? config.to
    : config.to
      ? [config.to]
      : [];
  const recipients = recipientTemplates
    .map((tpl) => decode(renderTemplate(tpl, context)).trim())
    .filter(Boolean);
  const to = recipients.join(", ");
  const subject = decode(renderTemplate(config.subject ?? "", context)).trim();
  const body = decode(renderTemplate(config.body ?? "", context));

  try {
    const result = await step.run("gmail-send-message", async () => {
      if (!to) {
        throw new NonRetriableError("Gmail Action node: To is required");
      }
      if (!subject) {
        throw new NonRetriableError("Gmail Action node: Subject is required");
      }
      if (!body.trim()) {
        throw new NonRetriableError("Gmail Action node: Body is required");
      }

      const accessToken = await refreshGoogleTokenIfNeeded(userId);

      const rfc2822 = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}`;
      const raw = toBase64Url(rfc2822);

      await ky.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          json: { raw },
        },
      );

      return {
        ...context,
        [outputKey]: {
          to,
          subject,
          body,
        },
      };
    });

    await publish(
      gmailActionChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      gmailActionChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
