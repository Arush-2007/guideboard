import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import {
  ExpressionError,
  evaluateExpression,
  toPlainDecimal,
} from "@/lib/expression";
import { PLACEHOLDER_RE } from "@/lib/template-token";
import { renderTemplate } from "@/lib/templating";

type CalculatorData = {
  expression?: string;
};

type CalculatorOutput = {
  /** The computed value. */
  result: number;
  /**
   * The expression as it was actually evaluated, with every `@<path>@`
   * reference replaced by the number it resolved to. A run log that only showed
   * the template couldn't answer "why is this 0?" — this can.
   */
  expression: string;
};

/**
 * Symbols routinely wrapped around numbers by spreadsheets, forms and payment
 * providers. Stripped before parsing so `"₹1,234.50"` is a number a user can
 * multiply, without needing a Convert node in front of the Calculator.
 */
const CURRENCY_SYMBOLS = /[$€£₹¥]/g;

/** Thousands separators, which carry no value. */
const THOUSANDS_SEPARATORS = /,/g;

/**
 * Lenient string → number for values arriving from upstream nodes.
 *
 * Deliberately NOT shared with `toNumber` in `executions/lib/compare.ts`, which
 * looks similar but encodes the opposite policy: comparison's "numeric"
 * restraint is strict on purpose, so that `"1,000"` and `"1000"` are not quietly
 * treated as equal cells. Widening that to serve this node would change matching
 * behaviour across every comparing node. The two policies differ by intent, so
 * they stay separate.
 *
 * Returns `null` for anything that isn't cleanly a finite number — including an
 * empty string, which is what a missing path renders to.
 */
function coerceToNumber(raw: string): number | null {
  const cleaned = raw
    .replace(CURRENCY_SYMBOLS, "")
    .replace(THOUSANDS_SEPARATORS, "")
    .trim();

  if (cleaned === "") return null;

  // Whitespace still INSIDE the value means it was never a single number.
  // Stripping all whitespace unconditionally silently fused `"12 34"` — a
  // mis-split column, or two values in one cell — into 1234, and the node then
  // reported success on a number the user never entered. Surrounding space is
  // fine and already trimmed above; interior space is a red flag, so it fails
  // the same way `"N/A"` does.
  if (/\s/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Replaces every `@<path>@` reference in `expression` with the number it
 * resolves to against `context`.
 *
 * Each token is rendered INDIVIDUALLY through the shared `renderTemplate`
 * resolver rather than rendering the whole string in one pass, and this is a
 * correctness requirement, not a stylistic one: a single-pass render lets an
 * upstream *value* rewrite the expression's *structure*. With `x = "1+1"`,
 * `2 * @<x>@` would render to `2 * 1+1` and evaluate to 3 instead of 4. Here
 * every substitution is a validated number, so the parse can't be altered by
 * data — the same reasoning behind parameterised SQL.
 *
 * @throws {NonRetriableError} naming the path and the offending value. A value
 *   that isn't a number won't become one on retry, and a silent 0 would put a
 *   wrong total into a sheet or an invoice.
 */
export function resolveExpressionVariables(
  expression: string,
  context: Record<string, unknown>,
): string {
  return expression.replace(PLACEHOLDER_RE, (token, path: string) => {
    const raw = renderTemplate(token, context);
    const value = coerceToNumber(raw);

    if (value === null) {
      throw new NonRetriableError(
        raw === ""
          ? `Calculator: ${path} has no value, so there's nothing to calculate with. Check that the step before this one ran and produced that field.`
          : `Calculator: ${path} is not a number (got "${raw}").`,
      );
    }

    // Plain decimal, never exponential: `String(1e-7)` is "1e-7", which the
    // tokenizer would reject as an unknown name — failing on a number that was
    // perfectly valid. See `toPlainDecimal`.
    const literal = toPlainDecimal(value);

    // Parenthesise negatives so they can't merge with a preceding operator:
    // `1 - @<x>@` with x = -3 must stay `1 - (-3)`, not become `1 - -3`. Both
    // happen to evaluate the same here, but the bracket keeps the substitution
    // structurally inert in every position.
    return value < 0 ? `(${literal})` : literal;
  });
}

export const calculatorExecutor: NodeExecutor<CalculatorData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  try {
    const config = parseNodeConfig(NodeType.CALCULATOR, data) as CalculatorData;

    const template = config.expression ?? "";

    // Handlebars is still honoured elsewhere, but it can't be made structurally
    // safe here the way `@<...>@` can, and a bare `{` would otherwise fail with
    // an opaque "isn't something this calculator can use". Point the user at the
    // key that does the right thing.
    if (template.includes("{{")) {
      throw new NonRetriableError(
        "Calculator: {{...}} isn't supported here. Use the {x} key to insert a value from an earlier step.",
      );
    }

    const expression = resolveExpressionVariables(template, context);
    const result = evaluateExpression(expression);

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );

    return {
      ...context,
      [outputKey]: { result, expression } satisfies CalculatorOutput,
    };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );

    if (error instanceof NonRetriableError) throw error;

    // Everything this node can fail on — a malformed expression, a bad config,
    // a non-numeric input — is deterministic given the same context. There is
    // no network call and no side effect, so a retry would fail identically.
    if (error instanceof ExpressionError) {
      throw new NonRetriableError(`Calculator: ${error.message}`);
    }
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Calculation failed",
    );
  }
};
