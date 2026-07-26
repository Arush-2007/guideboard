"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { nodeTypeLabel } from "@/config/node-options";
import { applyNodeRename, nodeDisplayName } from "@/lib/node-ref";

/**
 * The node settings dialog's title, which doubles as its rename control.
 *
 * Shows the node's name — its ref, e.g. `AI_TEXT_1`, the same identity the
 * canvas caption and the variable picker use — and, clicked, becomes an inline
 * input, mirroring the workflow-name rename in the editor header. Renaming
 * changes that ref everywhere at once; `applyNodeRename` owns the whole
 * transform and its validation (sanitize → slug, reject empty/unchanged/
 * duplicate, rewrite every downstream `@<oldRef…>@` reference), so this is
 * purely its dialog-side UI and the logic stays in one unit-tested place.
 *
 * The edit input always starts EMPTY with the current name as its placeholder —
 * one consistent "just type the new name" pattern for every node, so a node that
 * already has a name (an action) behaves the same as one that doesn't yet (an
 * unrenamed trigger); neither makes you clear pre-filled text first.
 *
 * Renders a `DialogTitle` in BOTH states (it's the Radix dialog's required
 * accessible title) and reads/writes through `useReactFlow` — the same store the
 * config forms, Save, and the history observer use — landing the rename as a
 * single history entry. The display re-reads the store each render, so a
 * committed rename shows immediately (the state change that ends editing also
 * triggers that re-read).
 */
export function EditableNodeTitle({ nodeId }: { nodeId: string }) {
  const { getNodes, setNodes } = useReactFlow();

  const node = getNodes().find((n) => n.id === nodeId);
  // Action nodes always carry an auto-assigned ref and show that; unrenamed
  // triggers have no name yet and fall back to their type label ("Telegram
  // Trigger"). `nodeDisplayName` owns that rule, shared with the variable
  // picker's node list so a node reads the same in both places.
  const displayLabel = nodeDisplayName(node, nodeTypeLabel);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEditing = () => {
    setDraft("");
    setEditing(true);
  };

  const cancel = () => {
    setDraft("");
    setEditing(false);
  };

  const commit = () => {
    setEditing(false);
    setDraft("");
    const { nodes, check } = applyNodeRename(getNodes(), nodeId, draft);
    if (!check.ok) {
      // Empty (nothing typed) and unchanged are silent no-ops; only a real
      // collision needs explaining.
      if (check.reason === "duplicate") {
        toast.error("You can't name two nodes the same");
      }
      return;
    }
    setNodes(nodes);
  };

  if (editing) {
    return (
      <DialogTitle asChild>
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Keep the rename input's keys inside it: Escape must cancel the
            // edit only, NOT bubble to Radix's dismiss layer and close the whole
            // dialog; and typing must not trigger the canvas keyboard shortcuts.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="mx-auto h-8 w-auto min-w-[8rem] max-w-full text-center text-lg font-semibold"
          aria-label="Node name"
          placeholder={displayLabel}
        />
      </DialogTitle>
    );
  }

  return (
    <DialogTitle asChild>
      <button
        type="button"
        onClick={startEditing}
        title="Click to rename"
        className="mx-auto cursor-pointer rounded px-1.5 py-0.5 hover:bg-muted/60"
      >
        {displayLabel}
      </button>
    </DialogTitle>
  );
}
