import { NonRetriableError } from "inngest";
import ky, { type Options as KyOptions } from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { httpRequestChannel } from "@/inngest/channels/http-request";
import { renderTemplate } from "@/lib/templating";

type HttpRequestData = {
  endpoint?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
};

export const httpRequestExecutor: NodeExecutor<HttpRequestData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    httpRequestChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: HttpRequestData;
  try {
    config = parseNodeConfig(NodeType.HTTP_REQUEST, data) as HttpRequestData;
  } catch (error) {
    await publish(
      httpRequestChannel(userId).status({
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
          httpRequestChannel(userId).status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError(
          "HTTP Request node: No endpoint configured",
        );
      }

      if (!config.method) {
        await publish(
          httpRequestChannel(userId).status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError("HTTP Request node: Method not configured");
      }

      const endpoint = renderTemplate(config.endpoint, context);
      const method = config.method;

      const options: KyOptions = { method };

      if (["POST", "PUT", "PATCH"].includes(method)) {
        const resolved = renderTemplate(config.body || "{}", context);
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
        [outputKey]: responsePayload,
      };
    });

    await publish(
      httpRequestChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      httpRequestChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
