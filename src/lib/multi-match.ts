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
 *     directly.
 *  4. Drop `<MultiMatchSelect>` into its dialog.
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
};

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
