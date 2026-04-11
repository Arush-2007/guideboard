"use client";

import { Braces } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Edge, Node } from "@xyflow/react";

/** Same pattern as executors: `${NodeType.toLowerCase()}_${nodeId}` */
export function getOutputKeyForNode(nodeType: string, nodeId: string): string {
  return `${nodeType.toLowerCase()}_${nodeId}`;
}

/**
 * All nodes that have a directed edge into `currentNodeId` (transitive),
 * i.e. every upstream node whose output may be available in context before
 * this node runs.
 */
export function getUpstreamNodeIds(
  currentNodeId: string,
  edges: Pick<Edge, "source" | "target">[],
): Set<string> {
  const upstream = new Set<string>();

  function visit(id: string) {
    for (const e of edges) {
      if (e.target === id && e.source !== id && !upstream.has(e.source)) {
        upstream.add(e.source);
        visit(e.source);
      }
    }
  }

  visit(currentNodeId);
  return upstream;
}

export type VariablePickerProps = {
  currentNodeId: string;
  workflowId?: string;
  onSelect: (variablePath: string) => void;
  disabled?: boolean;
  className?: string;
};

export function VariablePicker({
  currentNodeId,
  workflowId,
  onSelect,
  disabled,
  className,
}: VariablePickerProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);

  const enabled = Boolean(workflowId && currentNodeId);

  const { data: workflow, isLoading } = useQuery({
    ...trpc.workflows.getOne.queryOptions({ id: workflowId ?? "" }),
    enabled,
  });

  const items = useMemo(() => {
    if (!workflow?.nodes || !workflow?.edges) return [];

    const upstreamIds = getUpstreamNodeIds(currentNodeId, workflow.edges);
    const nodeById = new Map<string, Node>(
      workflow.nodes.map((n) => [n.id, n]),
    );

    const rows: { id: string; type: string; key: string; label: string }[] =
      [];

    for (const id of [...upstreamIds].sort()) {
      const node = nodeById.get(id);
      if (!node?.type) continue;
      const key = getOutputKeyForNode(String(node.type), id);
      const label = String(node.type).replace(/_/g, " ");
      rows.push({ id, type: String(node.type), key, label });
    }

    return rows;
  }, [workflow, currentNodeId]);

  const busy = enabled && isLoading;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("size-8 shrink-0", className)}
          disabled={disabled || !enabled || busy}
          aria-label="Insert variable from upstream nodes"
        >
          <Braces className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">
          Upstream variables
        </div>
        {busy ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            Loading workflow…
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No upstream nodes connected before this step.
          </div>
        ) : (
          <ScrollArea className="max-h-64">
            <ul className="p-1">
              {items.map((row) => {
                const full = `{{${row.key}}}`;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        onSelect(full);
                        setOpen(false);
                      }}
                    >
                      <span className="font-medium capitalize text-foreground">
                        {row.label}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {full}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
