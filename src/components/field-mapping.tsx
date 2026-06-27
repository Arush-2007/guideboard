"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { VariableInput } from "@/components/variable-input";
import { getUpstreamFields } from "@/lib/upstream-fields";

export type FieldMappingTarget = { key: string; label: string };

export type FieldMappingProps = {
  /** The target fields/columns to map onto (e.g. the sheet's headers). */
  targets: FieldMappingTarget[];
  /** Current mapping: target key -> template string (may contain @<path>@). */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  currentNodeId: string;
  workflowId?: string;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The reusable "match the columns" UI: each target gets a `<VariableInput>` so
 * the user can type a literal value or insert an upstream field (`@<path>@`)
 * via the picker. "Auto-map by name" pre-fills targets whose name matches an
 * available upstream field. Reads the live canvas (not the saved copy).
 */
export function FieldMapping({
  targets,
  value,
  onChange,
  currentNodeId,
  workflowId,
}: FieldMappingProps) {
  const nodes = useNodes();
  const edges = useEdges();

  const setField = (key: string, v: string) => {
    onChange({ ...value, [key]: v });
  };

  const autoMap = () => {
    const fields = getUpstreamFields(currentNodeId, nodes, edges);
    const next = { ...value };
    for (const target of targets) {
      if (next[target.key]?.trim()) continue; // never overwrite a user value
      const tnorm = normalize(target.label || target.key);
      const match = fields.find((f) => {
        const fnorm = normalize(f.fieldLabel);
        return (
          fnorm === tnorm || fnorm.includes(tnorm) || tnorm.includes(fnorm)
        );
      });
      if (match) next[target.key] = match.insertText;
    }
    onChange(next);
  };

  if (targets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Pick a spreadsheet and tab to load its columns.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Match each column to a value or an upstream field.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={autoMap}>
          <Wand2 className="mr-1.5 size-3.5" />
          Auto-map by name
        </Button>
      </div>
      <div className="space-y-3">
        {targets.map((target) => (
          <div
            key={target.key}
            className="grid grid-cols-[1fr_1.6fr] items-center gap-3"
          >
            <Label
              className="truncate text-sm font-medium"
              title={target.label}
            >
              {target.label}
            </Label>
            <VariableInput
              value={value[target.key] ?? ""}
              onChange={(e) => setField(target.key, e.target.value)}
              placeholder="Type a value or insert a field"
              currentNodeId={currentNodeId}
              workflowId={workflowId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
