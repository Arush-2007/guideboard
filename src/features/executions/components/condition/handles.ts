/**
 * The Condition node's output handle ids. This is the single contract shared by
 * the canvas node (handle ids become each edge's stored `fromOutput`) and the
 * executor (which emits one of these via `routed(...)`). Keeping them here means
 * the two sides can never drift.
 */
export const CONDITION_OUTPUTS = {
  TRUE: "true",
  FALSE: "false",
} as const;

export const CONDITION_OUTPUT_HANDLES = [
  { id: CONDITION_OUTPUTS.TRUE, label: "True" },
  { id: CONDITION_OUTPUTS.FALSE, label: "False" },
] as const;
