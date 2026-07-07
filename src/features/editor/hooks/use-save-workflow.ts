"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useUpdateWorkflow } from "@/features/workflows/hooks/use-workflows";
import { serializeSnapshot } from "../lib/snapshot";
import { editorAtom, lastSavedSnapshotAtom } from "../store/atoms";

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
 */
export const useSaveEditorWorkflow = (workflowId: string) => {
  const editor = useAtomValue(editorAtom);
  const saveWorkflow = useUpdateWorkflow();
  const setLastSaved = useSetAtom(lastSavedSnapshotAtom);

  const save = useCallback(async () => {
    if (!editor) {
      return false;
    }

    const nodes = editor.getNodes();
    const edges = editor.getEdges();

    await saveWorkflow.mutateAsync({ id: workflowId, nodes, edges });
    setLastSaved(serializeSnapshot(nodes, edges));
    return true;
  }, [editor, saveWorkflow, setLastSaved, workflowId]);

  return { save, isSaving: saveWorkflow.isPending };
};
