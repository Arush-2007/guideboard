"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { Braces } from "lucide-react";
import { useMemo, useState } from "react";
import { CustomFeatureEntry } from "@/components/custom-feature-entry";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getCustomFeatures } from "@/config/custom-features";
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
  /** The field's current value — lets a custom feature pre-fill from its token. */
  currentValue?: string;
  /**
   * Insert the bare dotted context path (e.g. `ai_text_abc.output`) instead of
   * the `@<path>@` template form. Used by inputs that consume a raw path rather
   * than a rendered template — e.g. the Condition node's "Field path".
   */
  bare?: boolean;
  /**
   * Horizontal offset for the fixed popover anchor. Defaults to `ml-72` (≈ half
   * the standard `sm:max-w-xl` dialog). Pass `ml-96` when the picker lives in a
   * wider `WideOverlayPanel` (`sm:max-w-3xl`) so the popover clears its edge.
   */
  anchorClassName?: string;
};

/** Strips the `@<path>@` template wrapper down to the bare dotted path. */
function toBarePath(insertText: string): string {
  return insertText.replace(/^@<\s*/, "").replace(/\s*>@$/, "");
}

export function VariablePicker({
  currentNodeId,
  onSelect,
  disabled,
  className,
  bare,
  currentValue,
  anchorClassName = "ml-72",
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

  // Custom features belong to the CURRENT node's type (not an upstream node),
  // and are meaningless for bare-path inputs (they insert a `@<custom:…>@`
  // token, not a dotted path).
  const customFeatures = useMemo(() => {
    const node = nodes.find((n) => n.id === currentNodeId);
    return getCustomFeatures(node?.type);
  }, [nodes, currentNodeId]);
  const showCustom = !bare && customFeatures.length > 0;

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
      {/* Anchor the panel to a fixed point at the right edge of the centered
          config dialog, so it opens in the SAME place every time — independent
          of which field's button was clicked. anchorClassName sets the offset:
          ml-72 (18rem) ≈ half the dialog's sm:max-w-xl width; a WideOverlayPanel
          passes ml-96. top-1/2 + align="center" keeps it vertically centered
          next to the dialog. */}
      <PopoverAnchor
        className={cn(
          "pointer-events-none fixed top-1/2 left-1/2 h-0 w-0",
          anchorClassName,
        )}
      />
      <PopoverContent
        side="right"
        align="center"
        sideOffset={16}
        collisionPadding={16}
        className="w-80 border-primary/60 p-0"
      >
        <div className="border-b px-3 py-2 text-center text-sm font-medium">
          Insert a field
        </div>
        {groups.length === 0 && !showCustom ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No previous steps are connected before this one yet.
          </div>
        ) : (
          <div
            className="themed-scrollbar max-h-[60vh] overflow-y-auto overscroll-contain p-1"
            onWheel={(e) => {
              // The parent modal Dialog's scroll-lock (react-remove-scroll)
              // blocks wheel/trackpad scrolling on this portaled popover, so
              // drive the scroll manually — two-finger scrolling now works
              // (dragging the scrollbar already did).
              e.currentTarget.scrollTop += e.deltaY;
            }}
          >
            {showCustom ? (
              <div className="mb-1">
                <div className="px-2 py-1 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Custom
                </div>
                <ul>
                  {customFeatures.map((feature) => (
                    <CustomFeatureEntry
                      key={feature.id}
                      feature={feature}
                      currentValue={currentValue}
                      onInsert={(token) => {
                        onSelect(token);
                        setOpen(false);
                      }}
                    />
                  ))}
                </ul>
              </div>
            ) : null}
            {groups.map((group) => (
              <div key={group.fields[0].nodeId} className="mb-1">
                <div className="px-2 py-1 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.nodeLabel}
                </div>
                <ul>
                  {group.fields.map((row) => {
                    const inserted = bare
                      ? toBarePath(row.insertText)
                      : row.insertText;
                    return (
                      <li key={row.insertText}>
                        <button
                          type="button"
                          className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            onSelect(inserted);
                            setOpen(false);
                          }}
                        >
                          <span className="font-medium text-foreground">
                            {row.fieldLabel}
                          </span>
                          <span className="w-full break-all font-mono text-xs text-muted-foreground">
                            {inserted}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
