import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";
import { danglingRefsAtom } from "@/features/editor/store/atoms";
import type { DanglingRef } from "@/lib/dangling-refs";

/** Shared empty list, at one identity, so a clean node's slice never changes. */
const NONE: DanglingRef[] = [];

/**
 * A single node's dangling references — config naming a step that can't reach
 * it — or an empty list.
 *
 * Reads only this node's slice of the shared map via `selectAtom`, the same way
 * `useHasInvalidConfig` does, so a reference dying (or being fixed) re-renders
 * ONLY the affected node rather than every node on the canvas. The equality
 * check compares the entries rather than the array identity, because
 * <DanglingRefValidator> publishes a fresh map object on every real change and
 * `Object.is` on the arrays inside it would then re-render every flagged node
 * whenever any one of them changed.
 */
export function useDanglingRefs(nodeId: string): DanglingRef[] {
  const nodeAtom = useMemo(
    () =>
      selectAtom(
        danglingRefsAtom,
        (map): DanglingRef[] => map[nodeId] ?? NONE,
        (a, b) =>
          a.length === b.length &&
          a.every(
            (item, i) => item.path === b[i].path && item.field === b[i].field,
          ),
      ),
    [nodeId],
  );

  return useAtomValue(nodeAtom);
}
