import { NonRetriableError } from "inngest";
import { fanOut, type WorkflowContext } from "@/features/executions/types";
import { isFanOutItem } from "@/inngest/fan-out";
import {
  DEFAULT_MAX_FAN_OUT_ITEMS,
  type MultiMatchMode,
} from "@/lib/multi-match";

/**
 * Run-time half of the shared multi-match policy (see `src/lib/multi-match.ts`
 * for the adoption recipe and the client-safe config fragment). Server-only:
 * imports `inngest`, so keep it out of anything the editor bundle reaches.
 */

/**
 * Throws when `count` items exceed the fan-out cap. Exposed separately so a
 * node can enforce the cap EARLY — inside its `step.run`, on the true match
 * count, before hauling every item across the step's JSON checkpoint —
 * with the same user-facing message the policy itself uses.
 */
export function assertFanOutCap(
  count: number,
  maxItems: number | undefined,
  itemNoun = "item",
): void {
  const cap = maxItems ?? DEFAULT_MAX_FAN_OUT_ITEMS;
  if (count > cap) {
    throw new NonRetriableError(
      `Found ${count} matching ${itemNoun}s, which exceeds the ` +
        `"Max ${itemNoun}s" setting (${cap}). Raise it or narrow the filter.`,
    );
  }
}

/**
 * Applies the node's multi-match policy to its matched `items` and returns
 * what the executor should return. `output` is the node's normal, full output
 * object (it is what downstream sees in "first"/"error" mode, and what the
 * PARENT run shows — plus `fannedOut` — in "each" mode; children see the
 * node's reshaped per-item output via the `readFanOutSeed` short-circuit
 * instead).
 *
 * Failure modes are all `NonRetriableError`s (config-level, not transient):
 * "error" with more than one item, "each" beyond `maxItems`, and "each" inside
 * another fan-out's child run (nested fan-out would multiply children
 * combinatorially).
 *
 * `itemNoun` names one item in user-facing messages and must pluralize with a
 * plain "s" (e.g. "row").
 */
export function applyMultiMatchPolicy({
  mode,
  maxItems,
  items,
  totalCount,
  context,
  outputKey,
  output,
  itemNoun = "item",
}: {
  mode: MultiMatchMode | undefined;
  maxItems: number | undefined;
  items: unknown[];
  /**
   * True match count when `items` is a truncated view (e.g. the Sheets node
   * stores at most 100 rows in non-"each" modes). Only used for the "error"
   * check/message; "each" must always receive the FULL list as `items`.
   */
  totalCount?: number;
  context: WorkflowContext;
  outputKey: string;
  output: Record<string, unknown>;
  itemNoun?: string;
}) {
  const resolvedMode: MultiMatchMode = mode ?? "first";

  const trueCount = totalCount ?? items.length;
  if (resolvedMode === "error" && trueCount > 1) {
    throw new NonRetriableError(
      `Found ${trueCount} matching ${itemNoun}s, but this step is set to ` +
        `fail when more than one matches. Switch it to run once per ` +
        `${itemNoun} to process them all, or narrow the filter.`,
    );
  }

  if (resolvedMode === "each") {
    // Nested fan-out guard: another node's per-item seed in the context means
    // this run is already one item of a different fan-out.
    for (const [key, value] of Object.entries(context)) {
      if (key !== outputKey && isFanOutItem(value)) {
        throw new NonRetriableError(
          "Nested fan-out is not supported — this run is already processing " +
            "one item of another step's fan-out.",
        );
      }
    }

    assertFanOutCap(items.length, maxItems, itemNoun);

    // Zero items fans out zero children — the engine activates no outgoing
    // edge, so everything after this node is recorded SKIPPED in this run.
    return fanOut(
      { ...context, [outputKey]: { ...output, fannedOut: items.length } },
      items,
    );
  }

  // "first" (and "error" with 0..1 items): the node's normal output, matching
  // the pre-policy behavior — zero matches still continue downstream, since
  // workflows branch on fields like `matchCount`.
  return { ...context, [outputKey]: output };
}
