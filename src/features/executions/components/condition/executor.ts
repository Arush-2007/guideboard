import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import {
  type CompareOperator,
  evaluateCondition,
  pickCompareOptions,
} from "@/features/executions/lib/compare";
import { type NodeExecutor, routed } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { renderTemplate } from "@/lib/templating";
import { CONDITION_OUTPUTS } from "./handles";

type ConditionData = {
  field?: string;
  operator?: CompareOperator;
  value?: string;
  ignoreCase?: boolean;
  ignoreChars?: string;
  numeric?: boolean;
};

export const conditionExecutor: NodeExecutor<ConditionData> = async ({
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

  let config: ConditionData;
  try {
    config = parseNodeConfig(NodeType.CONDITION, data) as ConditionData;
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
    const passes = await step.run("condition", () => {
      const field = config.field;
      const operator = config.operator;
      if (!field || !operator) {
        throw new NonRetriableError(
          "Condition node: field and operator are required",
        );
      }

      // Both sides go through the single templating entry point: `@<path>@`
      // (or `{{...}}`) is resolved against the context, anything else is a
      // literal. So either operand can be a fixed value or a reference to a
      // previous node's output (e.g. comparing two node outputs).
      const fieldValue = renderTemplate(field, context);
      const compareValue = renderTemplate(config.value ?? "", context);
      return evaluateCondition(
        operator,
        fieldValue,
        compareValue,
        pickCompareOptions(config),
      );
    });

    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    // Route to the matching branch instead of stopping the run. An unconnected
    // branch simply has no active downstream, which naturally ends that path.
    // The boolean result is also written to the context (under this node's key)
    // so the execution view can show "Result: true/false" and downstream nodes
    // can reference it.
    //
    // Backward compat: workflows saved before branching wired the condition's
    // single output via the legacy handle ids ("main"/"source-1"). Emitting them
    // as aliases of the pass path means a legacy edge stays active exactly when
    // the old gate would have continued (passes) and inactive when it would have
    // stopped (fails) — preserving old behavior with no data migration.
    return routed(
      { ...context, [outputKey]: { result: passes } },
      passes
        ? [CONDITION_OUTPUTS.TRUE, "main", "source-1"]
        : [CONDITION_OUTPUTS.FALSE],
    );
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
