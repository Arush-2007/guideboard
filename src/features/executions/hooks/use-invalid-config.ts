import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";
import { invalidNodeConfigAtom } from "@/features/editor/store/atoms";

/**
 * Whether a single node currently has an invalid config.
 *
 * Reads only this node's slice of the shared invalid-config map via `selectAtom`.
 * Because the selected value is a primitive boolean, selectAtom's default
 * `Object.is` equality means a validity change re-renders ONLY the affected node
 * — fixing one node's config does not re-render every node on the canvas. The
 * map itself is owned by <ConfigValidator>, which validates the React Flow store
 * against the `node-schemas.ts` registry.
 */
export function useHasInvalidConfig(nodeId: string): boolean {
  const hasIssuesAtom = useMemo(
    () =>
      selectAtom(invalidNodeConfigAtom, (map): boolean => nodeId in map),
    [nodeId],
  );

  return useAtomValue(hasIssuesAtom);
}
