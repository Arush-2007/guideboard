"use client";

import { createId } from "@paralleldrive/cuid2";
import { useReactFlow } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  executionNodeOptions,
  type NodeOption,
  triggerNodeOptions,
} from "@/config/node-options";
import { stagedNodesAtom } from "@/features/editor/store/atoms";
import { NodeType } from "@/generated/prisma";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";

function NodeOptionRow({
  nodeType,
  selected,
  onSelect,
}: {
  nodeType: NodeOption;
  selected: boolean;
  onSelect: (nodeType: NodeOption) => void;
}) {
  const Icon = nodeType.icon;

  return (
    <div
      className={cn(
        "w-full justify-start h-auto py-5 px-4 rounded-none cursor-pointer border-l-2 hover:border-l-primary",
        selected ? "border-l-primary bg-primary/10" : "border-transparent",
      )}
      onClick={() => onSelect(nodeType)}
    >
      <div className="flex items-center gap-6 w-full overflow-hidden">
        {typeof Icon === "string" ? (
          <img
            src={Icon}
            alt={nodeType.label}
            className="size-5 shrink-0 object-contain rounded-sm"
          />
        ) : (
          <Icon className="size-5 shrink-0" />
        )}
        <div className="flex flex-col items-start text-left">
          <span className="font-medium text-sm">{nodeType.label}</span>
          <span className="text-xs text-muted-foreground">
            {nodeType.description}
          </span>
        </div>
        {selected && (
          <CheckIcon className="ml-auto size-4 shrink-0 text-primary" />
        )}
      </div>
    </div>
  );
}

interface NodeSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function NodeSelector({
  open,
  onOpenChange,
  children,
}: NodeSelectorProps) {
  const { getNodes } = useReactFlow();
  const staged = useAtomValue(stagedNodesAtom);
  const setStaged = useSetAtom(stagedNodesAtom);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<NodeType>>(new Set());

  const query = search.trim().toLowerCase();

  const filteredTriggerNodes = useMemo(
    () =>
      query
        ? triggerNodeOptions.filter((node) =>
            node.label.toLowerCase().includes(query),
          )
        : triggerNodeOptions,
    [query],
  );

  const filteredExecutionNodes = useMemo(
    () =>
      query
        ? executionNodeOptions.filter((node) =>
            node.label.toLowerCase().includes(query),
          )
        : executionNodeOptions,
    [query],
  );

  const hasResults =
    filteredTriggerNodes.length > 0 || filteredExecutionNodes.length > 0;

  // Toggle a node's selection. Selected nodes are sent to the staging tray when
  // "Selected for workflow" is clicked, so the user can pick several at once
  // without reopening the selector.
  const toggleNodeSelect = useCallback(
    (selection: NodeOption) => {
      setSelected((prev) => {
        const next = new Set(prev);

        if (next.has(selection.type)) {
          next.delete(selection.type);
          return next;
        }

        // Only one manual trigger is allowed per workflow — count both the
        // canvas and anything already waiting in the staging tray.
        if (selection.type === NodeType.MANUAL_TRIGGER) {
          const hasManualTrigger =
            getNodes().some((node) => node.type === NodeType.MANUAL_TRIGGER) ||
            staged.some((node) => node.type === NodeType.MANUAL_TRIGGER);

          if (hasManualTrigger) {
            toast.error("Only one manual trigger is allowed per workflow");
            return prev;
          }
        }

        next.add(selection.type);
        return next;
      });
    },
    [getNodes, staged],
  );

  const handleAddSelected = useCallback(() => {
    if (selected.size === 0) {
      return;
    }

    // Stage the chosen nodes; they only become real canvas nodes once the user
    // drags them out of the tray onto the canvas.
    const newStaged = [...selected].map((type) => ({
      id: createId(),
      type,
    }));

    setStaged((prev) => [...prev, ...newStaged]);
    setSelected(new Set());
    onOpenChange(false);
  }, [selected, setStaged, onOpenChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelected(new Set());
        setSearch("");
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent
        side="right"
        className="top-[2.97675rem] h-[calc(100vh-2.97675rem-162px)] w-full gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b">
          <SheetTitle className="sr-only">Add nodes to workflow</SheetTitle>
          <Button
            className="w-full"
            disabled={selected.size === 0}
            onClick={handleAddSelected}
          >
            <PlusIcon className="size-4" />
            Selected for workflow
            {selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {filteredTriggerNodes.length > 0 && (
            <div>
              {filteredTriggerNodes.map((nodeType) => (
                <NodeOptionRow
                  key={nodeType.type}
                  nodeType={nodeType}
                  selected={selected.has(nodeType.type)}
                  onSelect={toggleNodeSelect}
                />
              ))}
            </div>
          )}
          {filteredTriggerNodes.length > 0 &&
            filteredExecutionNodes.length > 0 && <Separator />}
          {filteredExecutionNodes.length > 0 && (
            <div>
              {filteredExecutionNodes.map((nodeType) => (
                <NodeOptionRow
                  key={nodeType.type}
                  nodeType={nodeType}
                  selected={selected.has(nodeType.type)}
                  onSelect={toggleNodeSelect}
                />
              ))}
            </div>
          )}
          {!hasResults && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No nodes found.
            </p>
          )}
        </div>
        <div className="border-t p-4">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search nodes"
              className="pl-9"
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
