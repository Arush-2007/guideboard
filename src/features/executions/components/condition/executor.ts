import { NonRetriableError } from "inngest";
import type {
  NodeExecutor,
  WorkflowContext,
} from "@/features/executions/types";
import { conditionChannel } from "@/inngest/channels/condition";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

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
  context,
  step,
  publish,
}) => {
  await publish(
    conditionChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: ConditionData;
  try {
    config = parseNodeConfig(NodeType.CONDITION, data) as ConditionData;
  } catch (error) {
    await publish(
      conditionChannel().status({
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
          conditionChannel().status({
            nodeId,
            status: "error",
          }),
        );
        throw new NonRetriableError(
          "Condition node: field and operator are required",
        );
      }

      const fieldValue = getByPath(context, field);
      const compareValue = config.value ?? "";
      const passes = evaluateCondition(operator, fieldValue, compareValue);

      if (!passes) {
        const stopOnFail = config.stopOnFail !== false;
        if (stopOnFail) {
          await publish(
            conditionChannel().status({
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
      conditionChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  } catch (error) {
    await publish(
      conditionChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
