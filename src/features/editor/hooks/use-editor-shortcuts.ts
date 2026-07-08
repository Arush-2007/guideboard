"use client";

import type { Node } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import {
  duplicateSelectedNodes,
  selectAllNodes,
  shouldSuppressShortcut,
} from "../lib/node-shortcuts";
import { historyControlsAtom, isDirtyAtom } from "../store/atoms";
import { useSaveEditorWorkflow } from "./use-save-workflow";

/**
 * The editor's global keyboard layer. One `window` keydown listener drives the
 * seams the earlier checkpoints published — the save path
 * (`useSaveEditorWorkflow`), the undo/redo engine (`historyControlsAtom`), and
 * the dirty flag — so shortcuts and their on-screen buttons stay in lock-step.
 *
 * Duplicate/select-all are applied through `editor.tsx`'s `setNodes` (useState),
 * *not* `useReactFlow().setNodes`: useState is the authoritative controlled prop,
 * so the change survives a later drag (a store-only write would be clobbered by
 * the prop re-sync) while still reaching the store for the canvas, Save, and the
 * history observer.
 *
 * Mount inside `<ReactFlowProvider>` (next to the other editor controllers). The
 * listener is bound once; the latest closures live in a ref so it never re-binds
 * when the dirty flag or undo/redo availability flips.
 */
export const useEditorShortcuts = (
  workflowId: string,
  setNodes: Dispatch<SetStateAction<Node[]>>,
) => {
  const { save } = useSaveEditorWorkflow(workflowId);
  const controls = useAtomValue(historyControlsAtom);
  const isDirty = useAtomValue(isDirtyAtom);

  const latest = useRef({ save, controls, isDirty, setNodes });
  latest.current = { save, controls, isDirty, setNodes };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const hasOpenDialog = Boolean(
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        ),
      );
      if (
        shouldSuppressShortcut(
          active?.tagName,
          Boolean(active?.isContentEditable),
          hasOpenDialog,
        )
      ) {
        return;
      }

      const {
        save: doSave,
        controls: history,
        isDirty: dirty,
        setNodes: applyNodes,
      } = latest.current;

      switch (event.key.toLowerCase()) {
        case "s":
          event.preventDefault();
          if (dirty) {
            void doSave();
          }
          break;
        case "z":
          event.preventDefault();
          if (event.shiftKey) {
            history?.redo();
          } else {
            history?.undo();
          }
          break;
        case "y":
          event.preventDefault();
          history?.redo();
          break;
        case "d":
          event.preventDefault();
          applyNodes((current) => duplicateSelectedNodes(current));
          break;
        case "a":
          event.preventDefault();
          applyNodes((current) => selectAllNodes(current));
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
};
