import type { NodeExecutor } from "@/features/executions/types";
import { typeformTriggerChannel } from "@/inngest/channels/typeform-trigger";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type TypeformTriggerData = Record<string, unknown>;

export const typeformTriggerExecutor: NodeExecutor<TypeformTriggerData> = async ({
  nodeId,
  context,
  step,
  publish,
  data,
}) => {
  await publish(
    typeformTriggerChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.TYPEFORM_TRIGGER, data);
  } catch (error) {
    await publish(
      typeformTriggerChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const result = await step.run("typeform-trigger", async () => context);

  await publish(
    typeformTriggerChannel().status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
