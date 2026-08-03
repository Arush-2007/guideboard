"use client";

import { useAtomValue } from "jotai";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  ConfirmDestructive,
  DanglingRefCard,
  DanglingRefRows,
} from "@/components/dangling-ref-ui";
import { NodeTypeIcon } from "@/components/node-type-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { nodeOptionByType, nodeTypeLabel } from "@/config/node-options";
import type { NodeType } from "@/generated/prisma";
import type { NodeDanglingRefs } from "@/lib/dangling-refs";
import { displayNameFor } from "@/lib/node-ref";
import {
  type DanglingSavePrompt,
  danglingSavePromptAtom,
} from "../store/atoms";

/**
 * The workflow-level half of the dangling-reference guard: shown when a save
 * would persist config naming steps that can't reach it.
 *
 * The per-node guard in each settings dialog only ever sees the node the user
 * chose to open. This one runs over the whole canvas from the single save path
 * (`useSaveEditorWorkflow`), so the duplicate-it-and-wire-it-wrong case is
 * caught however the save was triggered — the header button, Ctrl+S, or the nav
 * guard's "Save and leave".
 *
 * Three ways out, deliberately. "Save as-is" exists because a half-wired canvas
 * is a normal state to save mid-build: you often duplicate a node meaning to
 * wire it up a minute later, and forcing a strip there would destroy the fields
 * you were about to make valid again. Removing is the one that loses data, so it
 * is the one behind the checkbox.
 *
 * Mounted once inside the editor, reacting to `danglingSavePromptAtom` — the
 * same hand-off <NavGuardDialog> uses for a parked navigation.
 */
export const DanglingSaveDialog = () => {
  // Read-only: the save path owns the atom, and every exit from this dialog
  // goes through `decide` so the awaiting save is always resolved — clearing the
  // atom here instead would strand it forever.
  const prompt = useAtomValue(danglingSavePromptAtom);
  if (!prompt) return null;

  // A fresh warning must never arrive with the box already ticked, or the
  // destructive button sits one click away against something the user has not
  // read. Enforced by REMOUNTING on a change of content rather than by resetting
  // in an effect: an effect runs after the render that already painted the
  // button enabled, and a prompt replaced while one is up (Ctrl+S with the modal
  // open) never passes through a closed state to reset on.
  const key = prompt.found
    .map((e) => `${e.nodeId}:${e.refs.map((r) => r.path).join(",")}`)
    .join(";");
  return <DanglingSaveBody key={key} prompt={prompt} />;
};

const DanglingSaveBody = ({ prompt }: { prompt: DanglingSavePrompt }) => {
  const [confirmed, setConfirmed] = useState(false);
  const { found, decide } = prompt;
  const total = found.reduce((sum, entry) => sum + entry.refs.length, 0);
  const many = total > 1;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Dismissing by escape or the corner cross abandons the save, rather
        // than falling through to one of the two that write.
        if (!next) decide("cancel");
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
            {many
              ? `${total} values can't reach the steps using them`
              : "A value can't reach the step using it"}
          </DialogTitle>
          <DialogDescription>
            Nothing running before {many ? "these steps" : "this step"} produces{" "}
            {many ? "them" : "it"}, so {many ? "they" : "it"} would come out
            blank at run time. This usually happens after a step is duplicated
            or a connection is changed.
          </DialogDescription>
        </DialogHeader>

        <ul className="themed-scrollbar max-h-64 space-y-2 overflow-y-auto">
          {found.map((entry) => (
            <NodeRow key={entry.nodeId} entry={entry} />
          ))}
        </ul>

        <ConfirmDestructive
          id="dangling-save-confirm"
          checked={confirmed}
          onChange={setConfirmed}
        >
          Remove {many ? "these references" : "this reference"} from the{" "}
          {many ? "fields" : "field"} above. The rest of what was typed around{" "}
          {many ? "them" : "it"} is kept.
        </ConfirmDestructive>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => decide("cancel")}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => decide("as-is")}
          >
            Save as-is
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!confirmed}
            onClick={() => decide("remove")}
          >
            Remove and save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** One offending node: its canvas name, then each value it can't fill. */
const NodeRow = ({ entry }: { entry: NodeDanglingRefs }) => (
  <li>
    <DanglingRefCard>
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <NodeTypeIcon
            icon={nodeOptionByType[entry.nodeType as NodeType]?.icon}
          />
        </span>
        {/* Named by the one rule in node-ref.ts, so a row reads exactly as that
            node's caption on the canvas. */}
        {displayNameFor(entry.nodeRef, entry.nodeType, nodeTypeLabel)}
      </span>
      <DanglingRefRows refs={entry.refs} className="mt-1 space-y-0.5 pl-6" />
    </DanglingRefCard>
  </li>
);
