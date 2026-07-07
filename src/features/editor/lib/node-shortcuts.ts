import { createId } from "@paralleldrive/cuid2";
import type { Node } from "@xyflow/react";
import { NodeType } from "@/generated/prisma";

// How far a duplicated node is offset from its source, so the copy doesn't land
// exactly on top of the original.
const DUPLICATE_OFFSET = 40;

/**
 * Duplicate every currently-selected node (excluding the `INITIAL` placeholder,
 * which is a "pick a trigger" stand-in, not a real node). Each clone gets a
 * fresh id, a +40/+40 offset, a deep-copied `data`, and starts selected; the
 * originals are deselected so the selection follows the copies. Only
 * `type`/`position`/`data` are carried over — volatile React Flow fields
 * (`measured`, `width`, `dragging`, …) are dropped so the copy re-measures.
 *
 * Pure and side-effect free (the id generator is injectable for tests). If
 * nothing eligible is selected, the input array is returned unchanged so callers
 * can no-op without a store write. Callers apply the result through
 * `editor.tsx`'s `setNodes` (useState) so the controlled prop stays
 * authoritative and the store observer records it as one history entry.
 */
export const duplicateSelectedNodes = (
  nodes: Node[],
  makeId: () => string = createId,
): Node[] => {
  const selected = nodes.filter(
    (node) => node.selected && node.type !== NodeType.INITIAL,
  );
  if (selected.length === 0) {
    return nodes;
  }

  const clones: Node[] = selected.map((node) => ({
    id: makeId(),
    type: node.type,
    position: {
      x: node.position.x + DUPLICATE_OFFSET,
      y: node.position.y + DUPLICATE_OFFSET,
    },
    data: structuredClone(node.data),
    selected: true,
  }));

  return [
    ...nodes.map((node) =>
      node.selected ? { ...node, selected: false } : node,
    ),
    ...clones,
  ];
};

/**
 * Mark every node selected. Returns the same array reference when all nodes are
 * already selected (or the list is empty) so the caller can skip a redundant
 * store write. `selected` is excluded from the history snapshot key, so applying
 * this never records a history entry or marks the editor dirty.
 */
export const selectAllNodes = (nodes: Node[]): Node[] => {
  if (nodes.every((node) => node.selected)) {
    return nodes;
  }
  return nodes.map((node) =>
    node.selected ? node : { ...node, selected: true },
  );
};

/**
 * Whether an editor keyboard shortcut should be swallowed because the user is
 * typing or a modal is open. Kept pure (operates on primitives, not the DOM) so
 * it's unit-testable in the Node test env; the hook reads `document` and passes
 * the values in.
 */
export const shouldSuppressShortcut = (
  activeTagName: string | undefined,
  isContentEditable: boolean,
  hasOpenDialog: boolean,
): boolean => {
  if (hasOpenDialog || isContentEditable) {
    return true;
  }
  const tag = activeTagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};
