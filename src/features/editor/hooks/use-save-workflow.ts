"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useUpdateWorkflow } from "@/features/workflows/hooks/use-workflows";
import {
  findDanglingRefsByNode,
  stripDanglingRefsInNodes,
} from "@/lib/dangling-refs";
import { serializeSnapshot } from "../lib/snapshot";
import {
  danglingSavePromptAtom,
  editorAtom,
  lastSavedSnapshotAtom,
} from "../store/atoms";

/**
 * The single save path for the editor. Reads the live nodes/edges from the
 * React Flow instance (the same source the canvas renders from), persists them,
 * and — on success — records the saved snapshot so dirty-tracking resets.
 *
 * Shared by the header Save button, the navigation-guard "Save and leave"
 * action, and the Ctrl+S shortcut so all three stay in lock-step. It uses
 * `mutateAsync` and lets callers await/catch, rather than baking the snapshot
 * update into the shared `useUpdateWorkflow` hook (which is also used off the
 * editor).
 *
 * It is also where DANGLING references are caught at the door. That check has to
 * live here, not on the Save button: a node's own dialog only sees the node the
 * user chose to open, and the two other callers of this hook would otherwise
 * persist a broken canvas without a word. Being the one save path is exactly
 * what makes this the right seam.
 */
export const useSaveEditorWorkflow = (workflowId: string) => {
  const editor = useAtomValue(editorAtom);
  const saveWorkflow = useUpdateWorkflow();
  const setLastSaved = useSetAtom(lastSavedSnapshotAtom);
  const setPrompt = useSetAtom(danglingSavePromptAtom);

  const save = useCallback(async () => {
    if (!editor) {
      return false;
    }

    let nodes = editor.getNodes();
    const edges = editor.getEdges();

    const found = findDanglingRefsByNode(nodes, edges);
    if (found.length > 0) {
      // Park the decision in the atom and wait for <DanglingSaveDialog> to make
      // it. Awaiting rather than firing-and-forgetting is what lets the nav
      // guard's "Save and leave" still navigate only after a real save.
      const choice = await new Promise<"cancel" | "as-is" | "remove">(
        (resolve) => {
          setPrompt((previous) => {
            // Displacing a prompt that is still up would strand the save
            // awaiting it — its `decide` would be unreachable and its promise
            // would never settle, leaving that caller hung forever. Settle it as
            // a cancel: it never got an answer, so it must not write.
            previous?.decide("cancel");
            return {
              found,
              decide: (next) => {
                setPrompt(null);
                resolve(next);
              },
            };
          });
        },
      );

      if (choice === "cancel") return false;
      if (choice === "remove") {
        // Strip against the list the user was SHOWN, then push it to the store
        // so the canvas and the persisted copy agree — otherwise the fields
        // would silently repopulate from the store on the next render and the
        // editor would go straight back to dirty.
        nodes = stripDanglingRefsInNodes(nodes, found);
        editor.setNodes(nodes);
      }
    }

    await saveWorkflow.mutateAsync({ id: workflowId, nodes, edges });
    setLastSaved(serializeSnapshot(nodes, edges));
    return true;
  }, [editor, saveWorkflow, setLastSaved, setPrompt, workflowId]);

  return { save, isSaving: saveWorkflow.isPending };
};
