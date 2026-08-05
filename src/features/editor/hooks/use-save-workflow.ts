"use client";

import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useUpdateWorkflow } from "@/features/workflows/hooks/use-workflows";
import {
  findDanglingRefsByNode,
  stripDanglingRefsInNodes,
} from "@/lib/dangling-refs";
import { openSavePrompt } from "../lib/save-prompt";
import { serializeSnapshot } from "../lib/snapshot";
import {
  danglingSavePromptAtom,
  editorAtom,
  lastSavedSnapshotAtom,
  type SaveChoice,
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
  // Reads the prompt atom WITHOUT subscribing. `useAtomValue` would re-render
  // every consumer of this hook each time a prompt opens or closes, for a value
  // only ever read at the instant a save starts.
  const store = useStore();

  /**
   * Settles the prompt this hook is currently awaiting, if any.
   *
   * Held in a ref so the unmount cleanup below can reach it without becoming a
   * dependency — an effect that re-ran whenever the pending save changed would
   * tear down and re-arm the very guard it exists to provide.
   */
  const pendingRef = useRef<((choice: SaveChoice) => void) | null>(null);

  useEffect(
    // The editor going away with the warning still up is the one exit nobody
    // else covers: `<DanglingSaveDialog>` unmounts with it, so no click can ever
    // reach `decide`, and an awaited save would hang for the life of the page.
    // The nav guard's "Save and leave" awaits `save()` before navigating, so
    // this is the difference between that flow failing and it freezing.
    () => () => {
      pendingRef.current?.("cancel");
    },
    [],
  );

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
      // guard's "Save and leave" still navigate only after a real save. Who may
      // end that wait, and the guarantee that only one of them counts, lives in
      // `openSavePrompt`.
      const { choice: pending, settle } = openSavePrompt(found, {
        get: () => store.get(danglingSavePromptAtom),
        set: setPrompt,
      });

      // Reachable by the unmount cleanup for exactly as long as the wait lasts.
      pendingRef.current = settle;
      const choice = await pending;
      pendingRef.current = null;

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
  }, [editor, saveWorkflow, setLastSaved, setPrompt, store, workflowId]);

  return { save, isSaving: saveWorkflow.isPending };
};
