import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";
import { unrunnableNodesAtom } from "@/features/editor/store/atoms";

/**
 * Why this node cannot run as currently wired, or `null` when it's fine.
 *
 * Reads only this node's slice of the shared map via `selectAtom`, mirroring
 * `useHasInvalidConfig`. The selected value is a primitive (string | null), so
 * selectAtom's `Object.is` equality means drawing or removing one edge
 * re-renders ONLY the nodes whose state actually flipped — not the whole canvas.
 * The map is owned by <ConnectivityValidator>, which derives it from the React
 * Flow store.
 */
export function useUnrunnableReason(nodeId: string): string | null {
  const reasonAtom = useMemo(
    () =>
      selectAtom(
        unrunnableNodesAtom,
        (map): string | null => map[nodeId] ?? null,
      ),
    [nodeId],
  );

  return useAtomValue(reasonAtom);
}
