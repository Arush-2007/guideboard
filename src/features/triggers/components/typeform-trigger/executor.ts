import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { typeformTriggerChannel } from "@/inngest/channels/typeform-trigger";

type TypeformTriggerData = {
  credentialId?: string;
  formId?: string;
  formTitle?: string;
  discoveredFields?: { path: string; label: string }[];
};

export const typeformTriggerExecutor: NodeExecutor<
  TypeformTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    typeformTriggerChannel(userId).status({ nodeId, status: "loading" }),
  );

  try {
    parseNodeConfig(NodeType.TYPEFORM_TRIGGER, data);
  } catch (error) {
    await publish(
      typeformTriggerChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  // Generic trigger: the webhook already seeded `typeform` (formId, submittedAt,
  // answers, and the addressable `fields` map) into the context. We pass it
  // straight through so any downstream node can reference the raw fields — no
  // domain-specific shaping.
  const result = await step.run("typeform-trigger", async () => context);

  await publish(
    typeformTriggerChannel(userId).status({ nodeId, status: "success" }),
  );

  return result;
};
