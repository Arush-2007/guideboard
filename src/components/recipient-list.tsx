"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VariableInput } from "@/components/variable-input";

export type RecipientListProps = {
  /** Current recipients. Each entry may be a literal value or a `!#path#!`
   * template. Always render at least one (blank) row. */
  value: string[];
  onChange: (next: string[]) => void;
  currentNodeId: string;
  workflowId?: string;
  placeholder?: string;
  addLabel?: string;
};

/**
 * Reusable "send to many" UI: a dynamic list of rows, each a `VariableInput`
 * so a recipient can be a fixed value (email/phone) OR pulled from an upstream
 * node via the field picker (`!#telegram.from.username#!`). Used by every
 * notify-style action (Email, WhatsApp, …). Reads the live canvas through
 * `VariableInput` → `VariablePicker`.
 */
export function RecipientList({
  value,
  onChange,
  currentNodeId,
  workflowId,
  placeholder = "Type a value or insert a field",
  addLabel = "Add recipient",
}: RecipientListProps) {
  // Never show zero rows — a single empty row is the empty state.
  const rows = value.length > 0 ? value : [""];

  const setRow = (index: number, v: string) => {
    const next = [...rows];
    next[index] = v;
    onChange(next);
  };

  const addRow = () => onChange([...rows, ""]);

  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : [""]);
  };

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and editable in place
        <div key={index} className="flex items-center gap-2">
          <VariableInput
            value={row}
            onChange={(e) => setRow(index, e.target.value)}
            placeholder={placeholder}
            currentNodeId={currentNodeId}
            workflowId={workflowId}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => removeRow(index)}
            disabled={rows.length === 1 && !rows[0]}
            aria-label="Remove recipient"
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addRow}
        className="mt-1"
      >
        <Plus className="mr-1.5 size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}
