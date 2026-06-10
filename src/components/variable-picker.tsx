"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { Braces } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getUpstreamFields,
  type UpstreamFieldRow,
} from "@/lib/upstream-fields";
import { cn } from "@/lib/utils";

export type VariablePickerProps = {
  currentNodeId: string;
  /** Kept for API compatibility; the picker now reads the live canvas. */
  workflowId?: string;
  onSelect: (variablePath: string) => void;
  disabled?: boolean;
  className?: string;
};

export function VariablePicker({
  currentNodeId,
  onSelect,
  disabled,
  className,
}: VariablePickerProps) {
  const [open, setOpen] = useState(false);

  // Read LIVE canvas state (not the saved server copy) so connections drawn a
  // moment ago are reflected immediately — no save required.
  const nodes = useNodes();
  const edges = useEdges();

  const groups = useMemo(() => {
    const rows = getUpstreamFields(currentNodeId, nodes, edges);

    const byNode = new Map<
      string,
      { nodeLabel: string; fields: UpstreamFieldRow[] }
    >();
    for (const row of rows) {
      const group = byNode.get(row.nodeId);
      if (group) group.fields.push(row);
      else byNode.set(row.nodeId, { nodeLabel: row.nodeLabel, fields: [row] });
    }
    return [...byNode.values()];
  }, [nodes, edges, currentNodeId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("size-8 shrink-0", className)}
          disabled={disabled}
          aria-label="Insert a field from upstream nodes"
        >
          <Braces className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">
          Insert a field from a previous step
        </div>
        {groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No previous steps are connected before this one yet.
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="p-1">
              {groups.map((group) => (
                <div key={group.fields[0].nodeId} className="mb-1">
                  <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.nodeLabel}
                  </div>
                  <ul>
                    {group.fields.map((row) => (
                      <li key={row.insertText}>
                        <button
                          type="button"
                          className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            onSelect(row.insertText);
                            setOpen(false);
                          }}
                        >
                          <span className="font-medium text-foreground">
                            {row.fieldLabel}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {row.insertText}
                            {row.example ? (
                              <span className="ml-2 not-italic text-muted-foreground/70">
                                e.g. {row.example}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
