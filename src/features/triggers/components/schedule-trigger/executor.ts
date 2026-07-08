import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";

type ScheduleTriggerData = Record<string, unknown>;

/**
 * Passthrough trigger: the cron fan-out (`handleSchedulePoll`) seeds
 * `{ schedule: { scheduledAt } }` into `initialData`, so this executor only
 * validates its config and threads context through — mirroring the other
 * polling triggers (Gmail, Sheets, YouTube).
 */
export const scheduleTriggerExecutor: NodeExecutor<
  ScheduleTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.SCHEDULE_TRIGGER, data);
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

  const result = await step.run("schedule-trigger", async () => context);

  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
