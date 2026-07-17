"use client";

import { createId } from "@paralleldrive/cuid2";
import { useReactFlow } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { MinusIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { OverlayCloseButton } from "@/components/ui/close-button";
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

// How many of one node type may be staged in a single trip through the selector.
// Only bounds the manual input — nothing about the engine cares.
const MAX_PER_TYPE = 99;

// The count control on a selected row: minus, an editable count, plus.
//
// Every control stops propagation because the row it sits in toggles selection
// on click, which would otherwise fire on top of each stepper press.
function NodeCountStepper({
  count,
  max,
  onChange,
}: {
  count: number;
  max: number;
  onChange: (next: number) => void;
}) {
  // Non-null only while the field is being typed in, so the input can sit
  // transiently empty without the count snapping to 0 under the cursor.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    setDraft(null);
    const parsed = Number.parseInt(raw, 10);
    onChange(Number.isNaN(parsed) ? count : parsed);
  };

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label="Remove one"
        className="size-7"
        onClick={(e) => {
          e.stopPropagation();
          onChange(count - 1);
        }}
      >
        <MinusIcon className="size-3.5" />
      </Button>
      <Input
        value={draft ?? String(count)}
        inputMode="numeric"
        aria-label="Count"
        className="h-7 w-10 px-1 text-center"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label="Add one"
        className="size-7"
        disabled={count >= max}
        onClick={(e) => {
          e.stopPropagation();
          onChange(count + 1);
        }}
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function NodeOptionRow({
  nodeType,
  count,
  max,
  onSelect,
  onCountChange,
}: {
  nodeType: NodeOption;
  count: number;
  max: number;
  onSelect: (nodeType: NodeOption) => void;
  onCountChange: (nodeType: NodeOption, next: number) => void;
}) {
  const Icon = nodeType.icon;
  const selected = count > 0;

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
        {/* The row's left border and tint already read as "selected", so the
            count replaces the tick rather than sitting beside it. */}
        {selected && (
          <NodeCountStepper
            count={count}
            max={max}
            onChange={(next) => onCountChange(nodeType, next)}
          />
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
  // type -> how many to stage. A type absent from the map is unselected; a count
  // is never stored as 0.
  const [selected, setSelected] = useState<Map<NodeType, number>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

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

  // The ceiling for a type's count. Only one manual trigger is allowed per
  // workflow, so it caps at 1 — or 0 once one exists on the canvas or is already
  // waiting in the staging tray. Drives both the clamp in `setCount` and the
  // stepper's plus-disabled state, so the rule lives in one place.
  const maxForType = useCallback(
    (type: NodeType) => {
      if (type !== NodeType.MANUAL_TRIGGER) {
        return MAX_PER_TYPE;
      }

      const hasManualTrigger =
        getNodes().some((node) => node.type === NodeType.MANUAL_TRIGGER) ||
        staged.some((node) => node.type === NodeType.MANUAL_TRIGGER);

      return hasManualTrigger ? 0 : 1;
    },
    [getNodes, staged],
  );

  // The single writer for selection counts — row clicks, the stepper, and typed
  // input all funnel through here so clamping and the trigger rule can't drift.
  const setCount = useCallback(
    (type: NodeType, next: number) => {
      const max = maxForType(type);
      const desired = Math.max(0, Math.trunc(next) || 0);

      // Only speak up when the *manual trigger* rule is what blocked them;
      // clamping at MAX_PER_TYPE is a guard rail, not something to announce.
      if (desired > max && type === NodeType.MANUAL_TRIGGER) {
        toast.error("Only one manual trigger is allowed per workflow");
      }

      const clamped = Math.min(desired, max);

      setSelected((prev) => {
        const map = new Map(prev);

        if (clamped === 0) {
          map.delete(type);
        } else {
          map.set(type, clamped);
        }

        return map;
      });
    },
    [maxForType],
  );

  // Clicking the row toggles between unselected and one. Counts beyond that come
  // from the stepper.
  const toggleNodeSelect = useCallback(
    (selection: NodeOption) => {
      setCount(selection.type, selected.has(selection.type) ? 0 : 1);
    },
    [selected, setCount],
  );

  const handleCountChange = useCallback(
    (selection: NodeOption, next: number) => {
      setCount(selection.type, next);
    },
    [setCount],
  );

  // Total nodes to stage, not distinct types — this is the number of chips the
  // tray will show.
  const totalSelected = useMemo(
    () => [...selected.values()].reduce((sum, count) => sum + count, 0),
    [selected],
  );

  const handleAddSelected = useCallback(() => {
    if (totalSelected === 0) {
      return;
    }

    // Stage the chosen nodes; they only become real canvas nodes once the user
    // drags them out of the tray onto the canvas. Each copy gets its own id —
    // the tray and the canvas drop handler both key off it.
    const newStaged = [...selected].flatMap(([type, count]) =>
      Array.from({ length: count }, () => ({ id: createId(), type })),
    );

    setStaged((prev) => [...prev, ...newStaged]);
    setSelected(new Map());
    onOpenChange(false);
  }, [selected, totalSelected, setStaged, onOpenChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelected(new Map());
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
        showCloseButton={false}
        // The close badge sits in the header, ahead of the search field, so it
        // would otherwise take the panel's opening focus and light up its ring
        // before the user has touched anything. Keep focus on the search field.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        className="top-editor-header h-[calc(100vh-var(--spacing-editor-header)-var(--spacing-editor-bar))] w-full gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b">
          <SheetTitle className="sr-only">Add nodes to workflow</SheetTitle>
          {/* The close badge straddles the button's top-right corner, so it
              needs a positioned wrapper sized to the button rather than the
              panel — the panel is flush to the viewport edge with no room. */}
          <div className="relative">
            <Button
              className="peer w-full"
              disabled={totalSelected === 0}
              onClick={handleAddSelected}
            >
              <PlusIcon className="size-4" />
              Selected for workflow
              {totalSelected > 0 ? ` (${totalSelected})` : ""}
            </Button>
            {/* The button's corner is rounded, so its painted edge cuts inside
                the box corner by r(1-1/√2) ≈ 3px on each axis. Insetting by that
                much lands the badge's centre on the curve itself rather than out
                in the empty space past it. Kept whole-pixel so the badge doesn't
                land on a fractional offset and render lopsided.

                The button lifts 2px on hover (`hover:-translate-y-0.5` in
                buttonVariants), so the badge tracks it via `peer-hover` — folded
                into one translate, since a bare `-translate-y-0.5` would replace
                the -50% rather than add to it and drop the badge onto the
                button. Disabled buttons take no pointer events, so no lift. */}
            <OverlayCloseButton className="top-[3px] right-[3px] -translate-y-1/2 translate-x-1/2 transition-[translate] duration-200 ease-out peer-hover:-translate-y-[calc(50%_+_2px)] peer-active:-translate-y-1/2" />
          </div>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {filteredTriggerNodes.length > 0 && (
            <div>
              {filteredTriggerNodes.map((nodeType) => (
                <NodeOptionRow
                  key={nodeType.type}
                  nodeType={nodeType}
                  count={selected.get(nodeType.type) ?? 0}
                  max={maxForType(nodeType.type)}
                  onSelect={toggleNodeSelect}
                  onCountChange={handleCountChange}
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
                  count={selected.get(nodeType.type) ?? 0}
                  max={maxForType(nodeType.type)}
                  onSelect={toggleNodeSelect}
                  onCountChange={handleCountChange}
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
              ref={searchRef}
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
