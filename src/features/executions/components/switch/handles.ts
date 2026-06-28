/**
 * Switch node output handles. A Switch routes to one of N user-defined case
 * outputs (matched in order) or to a `default` fallback. Each case carries a
 * stable `id` (frozen when the case is created in the dialog); that id is both
 * the canvas handle id (→ the edge's stored `fromOutput`) and what the executor
 * emits via `routed(...)`, so the two sides can never drift. Keeping the handle
 * derivation here means the node and the executor agree on a single contract.
 */
export const SWITCH_DEFAULT_OUTPUT = "default";

export interface SwitchCaseLike {
  id: string;
}

export function switchOutputHandles(
  cases: SwitchCaseLike[] = [],
): { id: string; label: string }[] {
  return [
    ...cases.map((c, index) => ({ id: c.id, label: `Case ${index + 1}` })),
    { id: SWITCH_DEFAULT_OUTPUT, label: "Default" },
  ];
}
