"use client";

import { useAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useSaveEditorWorkflow } from "../hooks/use-save-workflow";
import { navGuardTargetAtom } from "../store/atoms";

/**
 * Confirmation shown when the user tries to leave the editor (breadcrumb or
 * sidebar) with unsaved changes. Mounted once inside the editor so it has the
 * workflow id, the React Flow instance, and the save mutation on hand. The
 * pending destination lives in `navGuardTargetAtom`; guarded links park a href
 * there and this reacts.
 */
export const NavGuardDialog = ({ workflowId }: { workflowId: string }) => {
  const [target, setTarget] = useAtom(navGuardTargetAtom);
  const router = useRouter();
  const { save } = useSaveEditorWorkflow(workflowId);
  const [isSaving, setIsSaving] = useState(false);

  const open = target !== null;

  const go = () => {
    const href = target;
    setTarget(null);
    if (href) {
      router.push(href);
    }
  };

  const handleSaveAndLeave = async () => {
    setIsSaving(true);
    try {
      // Navigate only on a save that actually happened. `save()` resolves
      // `false` when the user backs out of the dangling-reference warning it
      // now raises — treating that as success would push the route anyway and
      // discard every unsaved change, which is the exact outcome this dialog
      // exists to prevent.
      if (await save()) go();
    } catch {
      // Save failed (a toast is already shown by the mutation). Keep the dialog
      // open so the user doesn't lose work by navigating away on a failed save.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isSaving) {
          setTarget(null);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave with unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes to this workflow. What would you like to
            do?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="ghost"
            onClick={() => setTarget(null)}
            disabled={isSaving}
          >
            Stay
          </Button>
          <Button variant="outline" onClick={go} disabled={isSaving}>
            Leave without saving
          </Button>
          <Button onClick={handleSaveAndLeave} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save and leave"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
