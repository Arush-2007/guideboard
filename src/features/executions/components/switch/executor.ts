import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import {
  type CompareOperator,
  evaluateCondition,
} from "@/features/executions/lib/compare";
import { type NodeExecutor, routed } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { switchChannel } from "@/inngest/channels/switch";
import { renderTemplate } from "@/lib/templating";
import { SWITCH_DEFAULT_OUTPUT } from "./handles";

type SwitchCase = {
  id: string;
  field?: string;
  operator?: CompareOperator;
  value?: string;
};

type SwitchData = {
  cases?: SwitchCase[];
};

export const switchExecutor: NodeExecutor<SwitchData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    switchChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: SwitchData;
  try {
    config = parseNodeConfig(NodeType.SWITCH, data) as SwitchData;
  } catch (error) {
    await publish(
      switchChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  try {
    // Evaluate cases in order; the first match wins. Each operand goes through
    // the single templating entry point, so a case can compare a fixed value or
    // an upstream reference (`@<...>@`). No match falls through to `default`.
    const matched = await step.run("switch", () => {
      for (const c of config.cases ?? []) {
        if (!c.id || !c.field || !c.operator) continue;
        const fieldValue = renderTemplate(c.field, context);
        const compareValue = renderTemplate(c.value ?? "", context);
        if (evaluateCondition(c.operator, fieldValue, compareValue)) {
          return c.id;
        }
      }
      return SWITCH_DEFAULT_OUTPUT;
    });

    await publish(
      switchChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    return routed(context, [matched]);
  } catch (error) {
    await publish(
      switchChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
