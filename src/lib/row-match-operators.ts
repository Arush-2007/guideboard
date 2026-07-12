import {
  COMPARE_OPERATOR_LABELS,
  type CompareOperator,
} from "@/features/executions/lib/compare";

/**
 * Single source of truth for the row-selection operator set used by the Sheets
 * `find_rows` and `color_rows` actions (`row-match.ts`) and their shared config
 * UI (`row-match-conditions.tsx`).
 *
 * Deliberately dependency-free (imports only the pure `compare.ts`) so the CLIENT
 * conditions component can read the operator list/labels WITHOUT pulling
 * `row-match.ts` — which imports the Handlebars-backed templating engine — into
 * its bundle. Client code imports these values (and the `RowMatchOperator` type)
 * from here, and only the *type* (never runtime) from `row-match.ts`.
 *
 * The 8 base operators stay tied to `compare.ts` (labels reused, type extended)
 * so they can never drift from the branching-node comparator.
 */
export type RowMatchOperator =
  | CompareOperator
  | "older_than_days"
  | "within_days"
  | "in_list";

/** The ONE place row-match operator labels live; the base 8 reuse compare.ts. */
export const ROW_MATCH_OPERATOR_LABELS: Record<RowMatchOperator, string> = {
  ...COMPARE_OPERATOR_LABELS,
  older_than_days: "Older than (days)",
  within_days: "Within (days)",
  in_list: "In list",
};

/** Ordered operator list, DERIVED from the labels — never a second hand list. */
export const ROW_MATCH_OPERATORS = Object.keys(
  ROW_MATCH_OPERATOR_LABELS,
) as RowMatchOperator[];

/** Operators that take no comparison value (the value input is hidden). */
export const VALUELESS_ROW_MATCH_OPERATORS: ReadonlySet<RowMatchOperator> =
  new Set<RowMatchOperator>(["is_empty", "is_not_empty"]);
