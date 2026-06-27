import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type {
  NodeExecutor,
  WorkflowContext,
} from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { conditionChannel } from "@/inngest/channels/condition";
import { renderTemplate } from "@/lib/templating";

type ConditionOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "is_empty"
  | "is_not_empty";

type ConditionData = {
  field?: string;
  operator?: ConditionOperator;
  value?: string;
  stopOnFail?: boolean;
};

function getByPath(obj: WorkflowContext, path: string): unknown {
  const keys = path
    .split(".")
    .map((k) => k.trim())
    .filter(Boolean);
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function asString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function evaluateCondition(
  operator: ConditionOperator,
  fieldValue: unknown,
  compareRaw: string,
): boolean {
  const sv = asString(fieldValue);

  switch (operator) {
    case "contains":
      return sv.includes(compareRaw);
    case "not_contains":
      return !sv.includes(compareRaw);
    case "equals":
      return sv === compareRaw;
    case "not_equals":
      return sv !== compareRaw;
    case "greater_than": {
      const a = Number(fieldValue);
      const b = Number(compareRaw);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        return a > b;
      }
      return sv > compareRaw;
    }
    case "less_than": {
      const a = Number(fieldValue);
      const b = Number(compareRaw);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        return a < b;
      }
      return sv < compareRaw;
    }
    case "is_empty":
      return isEmptyValue(fieldValue);
    case "is_not_empty":
      return !isEmptyValue(fieldValue);
    default:
      return false;
  }
}

export const conditionExecutor: NodeExecutor<ConditionData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    conditionChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: ConditionData;
  try {
    config = parseNodeConfig(NodeType.CONDITION, data) as ConditionData;
  } catch (error) {
    await publish(
      conditionChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  try {
    const result = await step.run("condition", async () => {
      const field = config.field;
      const operator = config.operator;
      if (!field || !operator) {
        await publish(
          conditionChannel(userId).status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError(
          "Condition node: field and operator are required",
        );
      }

      // Tolerate a `!#path#!` wrapper (e.g. legacy data or a manual paste):
      // the field is a bare context path, so strip the template markers.
      const barePath = field.replace(/^!#\s*/, "").replace(/\s*#!$/, "");
      const fieldValue = getByPath(context, barePath);
      // Render the compare value so users can reference upstream data
      // (e.g. `!#telegram.text#!`), consistent with every other node.
      const compareValue = renderTemplate(config.value ?? "", context);
      const passes = evaluateCondition(operator, fieldValue, compareValue);

      if (!passes) {
        const stopOnFail = config.stopOnFail !== false;
        if (stopOnFail) {
          await publish(
            conditionChannel(userId).status({
              nodeId,
              status: "error",
            }),
          );
          throw new NonRetriableError("Condition not met");
        }
      }

      return context;
    });

    await publish(
      conditionChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      conditionChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
