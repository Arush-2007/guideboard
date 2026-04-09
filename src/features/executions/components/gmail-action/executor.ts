import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import type { NodeExecutor } from "@/features/executions/types";
import { gmailActionChannel } from "@/inngest/channels/gmail-action";
import ky from "ky";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type GmailActionData = {
  to?: string;
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
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    gmailActionChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: GmailActionData;
  try {
    config = parseNodeConfig(NodeType.GMAIL_ACTION, data) as GmailActionData;
  } catch (error) {
    await publish(
      gmailActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const outputKey = `${NodeType.GMAIL_ACTION.toLowerCase()}_${nodeId}`;

  const to = decode(Handlebars.compile(config.to ?? "")(context)).trim();
  const subject = decode(Handlebars.compile(config.subject ?? "")(context)).trim();
  const body = decode(Handlebars.compile(config.body ?? "")(context));

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

      await ky.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        json: { raw },
      });

      return {
        ...context,
        [outputKey]: {
          to,
          subject,
        },
      };
    });

    await publish(
      gmailActionChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      gmailActionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
