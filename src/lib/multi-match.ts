import z from "zod";
import type { WorkflowContext } from "@/features/executions/types";
import { type FanOutItemSeed, isFanOutItem } from "@/inngest/fan-out";

/**
 * Shared multi-match vocabulary for list-producing nodes ("what happens when a
 * step matches more than one thing?"). This module is PURE (no inngest import)
 * because `node-schemas.ts` — and through it the editor's client bundle —
 * imports the config fragment; the run-time policy lives in
 * `src/features/executions/lib/multi-match-policy.ts`, and the dialog control
 * in `src/components/multi-match-select.tsx`.
 *
 * A node adopts the policy in four moves (see the Sheets find_rows action for
 * the reference integration):
 *  1. Spread `multiMatchConfigFields` into its config schema
 *     (`src/config/node-schemas.ts`).
 *  2. Short-circuit at the top of its executor: if `readFanOutSeed(context,
 *     outputKey)` returns a seed, this run is one child of a fan-out — reshape
 *     the seed into the node's OWN single-match output shape (keeping the
 *     `__fanOut: true` marker) and return, without re-doing the node's work.
 *  3. Pick the single result it acts on with `selectSingleMatch(...)` (that is
 *     what makes "last" differ from "first"), then end the list-producing path
 *     with `applyMultiMatchPolicy(...)` instead of returning the output
 *     directly — passing `onItemFailure: config.onItemFailure` through.
 *  4. Drop `<MultiMatchSelect>` into its dialog (or `<FanOutCapInput>` alone if
 *     the node always fans out and never chooses between first/each/error).
 *
 * Everything else is free. ORDERING in particular is not a per-node concern:
 * the engine chains child runs so items are processed in list order for every
 * fan-out node, present and future (see src/inngest/fan-out.ts). So is the
 * `onItemFailure` control, which `<FanOutCapInput>` renders wherever the cap is
 * offered.
 */

export const MULTI_MATCH_MODES = ["first", "last", "each", "error"] as const;

/**
 * - "first" (default): continue this run; downstream picks single values off
 *   the node's normal output (e.g. `firstRow.<col>`). Matches the pre-policy
 *   behavior exactly, including zero matches continuing downstream.
 * - "last": identical to "first" in every way except WHICH match the run acts
 *   on — the bottom-most instead of the topmost. It reads and writes the same
 *   output fields (`firstRow`, `rowIndex`, …), so switching a saved node
 *   between the two never breaks a downstream reference.
 * - "each": fan out — one child sub-execution per item; nothing downstream
 *   runs in this (the parent) run.
 * - "error": fail the run when more than one item matched.
 */
export type MultiMatchMode = (typeof MULTI_MATCH_MODES)[number];

/**
 * The ONE match a single-match mode acts on: the bottom-most in "last", the
 * topmost in every other mode ("first", "error", and an unset/legacy value).
 * `undefined` when nothing matched.
 *
 * Every place a node collapses a match list down to a single result goes
 * through this, so "last" selects the same item whichever action asks — the
 * row `find_rows` continues with, and the row `update_row` writes.
 *
 * "each" acts on ALL items, so a caller in that mode must not call this; it
 * hands the full list to `applyMultiMatchPolicy` instead.
 */
export function selectSingleMatch<T>(
  matches: readonly T[],
  mode: MultiMatchMode | undefined,
): T | undefined {
  return mode === "last" ? matches[matches.length - 1] : matches[0];
}

export const ON_ITEM_FAILURE_MODES = ["continue", "stop"] as const;

/**
 * What a FAILED item does to the rest of a fan-out ("each" only).
 *
 * - "continue" (default): the failed item is recorded FAILED and the chain
 *   hands on to the next one. This is what fan-out has always done — children
 *   used to be dispatched independently, so one failing never stopped the
 *   others — which makes it the back-compat-safe default.
 * - "stop": the remaining items never start. Because they then leave no trace
 *   of their own, the engine appends a sentence naming the count to the failed
 *   run's error, so "why did rows 8-50 never run?" is answerable from the run
 *   that stopped them.
 */
export type OnItemFailure = (typeof ON_ITEM_FAILURE_MODES)[number];

export const DEFAULT_ON_ITEM_FAILURE: OnItemFailure = "continue";

export const DEFAULT_MAX_FAN_OUT_ITEMS = 100;
/** Hard upper bound on the "each" cap — shared by server schema, form, UI. */
export const MAX_FAN_OUT_ITEMS_LIMIT = 1000;

/**
 * Config-schema fragment: spread into a node's Zod config object. Kept
 * `.optional()` (defaults applied at run time) so pre-existing saved nodes —
 * which stored `onMultipleMatches: "first" | "error"` or nothing at all —
 * remain valid with zero data migration; "each" is the new fan-out mode.
 *
 * NOTE: dialog form schemas must NOT spread this — `z.coerce.number()`'s
 * `unknown` input type breaks react-hook-form's resolver generics. Forms
 * declare `z.number().int().min(1).max(MAX_FAN_OUT_ITEMS_LIMIT).optional()`
 * and `z.enum(MULTI_MATCH_MODES).optional()` from the shared constants.
 */
export const multiMatchConfigFields = {
  onMultipleMatches: z.enum(MULTI_MATCH_MODES).optional(),
  /** Safety cap on how many child runs one fan-out may start ("each" only). */
  maxFanOutItems: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_FAN_OUT_ITEMS_LIMIT)
    .optional(),
  /** Whether a failed item stops the rest of the fan-out ("each" only). */
  onItemFailure: z.enum(ON_ITEM_FAILURE_MODES).optional(),
};

/**
 * The fragment's key names, DERIVED rather than hand-listed.
 *
 * Consumers that need to name every multi-match key — today
 * `nodeInactiveFields` in `src/config/node-references.ts`, which declares them
 * inactive for actions that don't fan out — must spread this instead of typing
 * the strings. A hand-copied list is a silent declaration site: adding
 * `onItemFailure` to the fragment compiled clean while leaving that list stale,
 * so the new key was reported as a dangling reference on every non-fan-out
 * Sheets action.
 */
export const MULTI_MATCH_CONFIG_KEYS = Object.keys(
  multiMatchConfigFields,
) as (keyof typeof multiMatchConfigFields)[];

/**
 * The config slice a fan-out node carries. Nodes intersect this into their own
 * data type (`type FooData = { … } & MultiMatchConfig`) and
 * `applyMultiMatchPolicy` takes it whole, so adding a fan-out setting is a
 * change to THIS fragment only — not to every executor call site.
 */
export type MultiMatchConfig = z.infer<
  z.ZodObject<typeof multiMatchConfigFields>
>;

/**
 * The per-item seed the engine's dispatcher planted under `outputKey`, or null
 * when this run is not a fan-out child. Executors call this FIRST so a child
 * run never re-does the parent's work (and never re-fans-out).
 */
export function readFanOutSeed(
  context: WorkflowContext,
  outputKey: string,
): FanOutItemSeed | null {
  const value = context[outputKey];
  return isFanOutItem(value) ? (value as FanOutItemSeed) : null;
}
