import { NonRetriableError } from "inngest";
import type { Options as KyOptions } from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { clampUserTimeout, http, rethrowTimeout } from "@/lib/http";
import { renderTemplate } from "@/lib/templating";

type HttpRequestData = {
  endpoint?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  /**
   * The one timeout a user sets, because this node calls arbitrary third parties and
   * no default is right for all of them. SECONDS (the unit the dialog speaks);
   * clamped to the platform's step budget — see `clampUserTimeout`.
   */
  timeoutSeconds?: number;
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
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: HttpRequestData;
  try {
    config = parseNodeConfig(NodeType.HTTP_REQUEST, data) as HttpRequestData;
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
  try {
    const result = await step.run("http-request", async () => {
      if (!config.endpoint) {
        await publish(
          nodeStatusChannel(userId).status({
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
          nodeStatusChannel(userId).status({
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

      // A user may ask for longer than the default, but never for longer than the
      // platform will actually run the step — an un-clamped value would surface as
      // an opaque platform kill rather than a clean node failure.
      const timeoutMs = clampUserTimeout(
        config.timeoutSeconds ? config.timeoutSeconds * 1000 : undefined,
      );

      // This node is the one place we KNOW the method, so we can classify honestly:
      // a timed-out GET is safe to retry, a timed-out POST/PUT/PATCH/DELETE may have
      // already landed on the third party and must not be repeated blindly.
      const isSafeMethod = method === "GET";

      const response = await http(endpoint, {
        ...options,
        timeout: timeoutMs,
      }).catch(
        rethrowTimeout({
          integration: `The API at ${endpoint}`,
          timeoutClass: isSafeMethod ? "READ" : "WRITE",
          // A GET is safe to repeat; a POST/PUT/PATCH/DELETE may already have
          // landed on the third party, and we cannot know whether it did.
          idempotent: isSafeMethod,
          timeoutMs,
          hint: "Raise this node's Timeout if the API is legitimately slow.",
        }),
      );
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
