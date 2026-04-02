import Handlebars from "handlebars";
import { NonRetriableError } from "inngest";
import ky, { type Options as KyOptions } from "ky";
import type { NodeExecutor } from "@/features/executions/types";
import { httpRequestChannel } from "@/inngest/channels/http-request";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type HttpRequestData = {
  variableName?: string;
  endpoint?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
};

export const httpRequestExecutor: NodeExecutor<HttpRequestData> = async ({
  data,
  nodeId,
  context,
  step,
  publish,
}) => {
  await publish(
    httpRequestChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: HttpRequestData;
  try {
    config = parseNodeConfig(NodeType.HTTP_REQUEST, data) as HttpRequestData;
  } catch (error) {
    await publish(
      httpRequestChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  try {
    const result = await step.run("http-request", async () => {
      if (!config.endpoint) {
        await publish(
          httpRequestChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("HTTP Request node: No endpoint configured");
      }

      if (!config.variableName) {
        await publish(
          httpRequestChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("HTTP Request node: Variable name not configured");
      }

      if (!config.method) {
        await publish(
          httpRequestChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("HTTP Request node: Method not configured");
      }

      const endpoint = Handlebars.compile(config.endpoint)(context);
      const method = config.method;

      const options: KyOptions = { method };

      if (["POST", "PUT", "PATCH"].includes(method)) {
        const resolved = Handlebars.compile(config.body || "{}")(context);
        JSON.parse(resolved);
        options.body = resolved;
        options.headers = {
          "Content-Type": "application/json",
        };
      }

      const response = await ky(endpoint, options);
      const contentType = response.headers.get("content-type");
      const responseData = contentType?.includes("application/json")
        ? await response.json()
        : await response.text();

      const responsePayload = {
        httpResponse: {
          status: response.status,
          statusText: response.statusText,
          data: responseData,
        },
      };

      return {
        ...context,
        [config.variableName]: responsePayload,
      }
    });

    await publish(
      httpRequestChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      httpRequestChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
