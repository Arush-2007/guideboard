"use client";

import { useReactFlow } from "@xyflow/react";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  ConfirmDestructive,
  DanglingRefCard,
  DanglingRefRows,
} from "@/components/dangling-ref-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  availablePaths,
  type DanglingRef,
  findDanglingRefs,
  stripDanglingRefs,
} from "@/lib/dangling-refs";

/**
 * The save-time guard against DANGLING references — a node's config naming a
 * step that cannot reach it. See `lib/dangling-refs.ts` for what makes a
 * reference dangle and why it has to be caught here.
 *
 * Every node dialog that can hold a `@<REF.path>@` token wires this in, not just
 * the ones a duplicate produced: the reference dies the same way whether the node
 * was cloned, an edge was cut, or a branch was re-parented, and only the node's
 * own save is in a position to notice. The check runs on the values being
 * submitted rather than on what is already stored, so an edit that ADDS a dead
 * reference is caught by the same pass.
 *
 * The alternative — dropping dead tokens silently — was rejected: the token is
 * the only surviving evidence of what the user meant that field to say, and a
 * config that quietly empties itself is exactly the failure this is meant to make
 * visible.
 */

/** A dead reference is never removed without an explicit, deliberate opt-in. */
const CONFIRM_LABEL = "Remove these references and save";

export type DanglingRefGuard<T> = {
  /**
   * Drop-in replacement for the dialog's own submit handler: clean configs pass
   * straight through untouched, so a node with no references never sees the
   * guard at all.
   */
  save: (values: T) => void;
  /** Render inside the dialog. Nothing is mounted until a save is held back. */
  dialog: ReactNode;
};

export function useDanglingRefGuard<T>({
  currentNodeId,
  onSave,
}: {
  currentNodeId: string;
  /** What the dialog would have done on submit — closing itself included. */
  onSave: (values: T) => void;
}): DanglingRefGuard<T> {
  // Read the graph on demand rather than through `useNodes`/`useEdges`: the
  // guard needs it once, at submit, and subscribing would re-render the whole
  // dialog on every unrelated canvas change. `getNodes`/`getEdges` also read the
  // React Flow STORE, which is the authoritative graph while a dialog is open —
  // see `editor/lib/live-graph.ts`.
  const { getNodes, getEdges } = useReactFlow();
  const [held, setHeld] = useState<{ values: T; found: DanglingRef[] } | null>(
    null,
  );

  const save = (values: T) => {
    const nodes = getNodes();
    const found = findDanglingRefs(
      values,
      availablePaths(currentNodeId, nodes, getEdges()),
      {
        // Drives which fields this node's CURRENT settings actually read, and
        // whether it is checked at all (see `config/node-references.ts`).
        //
        // The type comes from the canvas, but the DATA checked is the form's
        // submitted values — so a mode changed in this very dialog is judged by
        // the mode being saved, not the one on disk.
        nodeType: nodes.find((node) => node.id === currentNodeId)?.type,
      },
    );
    if (found.length === 0) {
      onSave(values);
      return;
    }
    setHeld({ values, found });
  };

  const dismiss = () => setHeld(null);

  const confirm = () => {
    if (!held) return;
    // Stripped by the exact PATHS that were listed, never by the steps behind
    // them — a step can be healthy with one value missing, and taking its
    // siblings out would erase fields that still work.
    const paths = new Set(held.found.map((d) => d.path));
    onSave(stripDanglingRefs(held.values, paths));
    setHeld(null);
  };

  return {
    save,
    dialog: held ? (
      <DanglingRefDialog
        found={held.found}
        onCancel={dismiss}
        onConfirm={confirm}
      />
    ) : null,
  };
}

const DanglingRefDialog = ({
  found,
  onCancel,
  onConfirm,
}: {
  found: DanglingRef[];
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  // Owned here, not by the hook: this component only exists while a save is
  // held, so it starts unticked by construction — and a tick doesn't re-render
  // the (sometimes very large) settings dialog the hook lives in.
  const [confirmed, setConfirmed] = useState(false);
  const many = found.length > 1;
  return (
    // A plain Dialog rather than an AlertDialog: this one stacks on top of the
    // node's settings dialog, and nesting two alert dialogs' focus traps fights
    // over the same escape key.
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
            {many
              ? "These values can't reach this step"
              : "This value can't reach this step"}
          </DialogTitle>
          <DialogDescription>
            Nothing running before this step produces{" "}
            {many ? "these values" : "this value"}, so {many ? "they" : "it"}{" "}
            would come out blank at run time. This usually happens after a step
            is duplicated or a connection is removed.
          </DialogDescription>
        </DialogHeader>

        {/* The VALUE that would come out blank, and the field it sits in — not
            the producing step's name, which on its own leaves the user to work
            out which of that step's values the field was pulling. */}
        <DanglingRefCard>
          <DanglingRefRows refs={found} className="space-y-1" />
        </DanglingRefCard>

        <p className="text-sm text-muted-foreground">
          Cancel to go back with your changes intact, then either connect the
          missing {many ? "steps" : "step"} or replace the{" "}
          {many ? "fields" : "field"} with something this step can reach.
        </p>

        <ConfirmDestructive
          id="dangling-ref-confirm"
          checked={confirmed}
          onChange={setConfirmed}
        >
          {CONFIRM_LABEL} — {many ? "these references" : "this reference"} will
          be erased from the {many ? "fields" : "field"}. The rest of what you
          typed is kept.
        </ConfirmDestructive>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!confirmed}
            onClick={onConfirm}
          >
            {CONFIRM_LABEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
