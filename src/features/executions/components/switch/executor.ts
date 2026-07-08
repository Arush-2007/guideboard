import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import {
  type CompareOperator,
  evaluateCondition,
} from "@/features/executions/lib/compare";
import { type NodeExecutor, routed } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
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

  let config: SwitchData;
  try {
    config = parseNodeConfig(NodeType.SWITCH, data) as SwitchData;
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
    // Evaluate cases in order; the first match wins. Each operand goes through
    // the single templating entry point, so a case can compare a fixed value or
    // an upstream reference (`@<...>@`). No match falls through to `default`.
    // We also derive a human label ("Case N" / "Default") for the execution view;
    // the field/operator/value criteria are reconstructed from config there.
    const matched = await step.run("switch", () => {
      const cases = config.cases ?? [];
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        if (!c.id || !c.field || !c.operator) continue;
        const fieldValue = renderTemplate(c.field, context);
        const compareValue = renderTemplate(c.value ?? "", context);
        if (evaluateCondition(c.operator, fieldValue, compareValue)) {
          return { id: c.id, label: `Case ${i + 1}` };
        }
      }
      return { id: SWITCH_DEFAULT_OUTPUT, label: "Default" };
    });

    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    // Record the chosen branch under this node's key so the execution view can
    // show "Case N matched"; route only the matched output's edge.
    return routed({ ...context, [outputKey]: { matched: matched.label } }, [
      matched.id,
    ]);
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
