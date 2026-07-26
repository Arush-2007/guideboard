"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { Braces, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CustomFeatureEntry } from "@/components/custom-feature-entry";
import { NodeTypeIcon } from "@/components/node-type-icon";
import { Button } from "@/components/ui/button";
import { OverlayCloseAction } from "@/components/ui/close-button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getCustomFeatures } from "@/config/custom-features";
import { nodeOptionByType, nodeTypeLabel } from "@/config/node-options";
import type { NodeType } from "@/generated/prisma";
import {
  buildPickerSources,
  getUpstreamFields,
  type PickerExtraGroup,
  type PickerFieldRow,
  type PickerSource,
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
  /** Fields the current node supplies itself (see PickerExtraGroup). */
  extraGroups?: PickerExtraGroup[];
  /**
   * Insert the bare dotted context path (e.g. `ai_text_abc.output`) instead of
   * the `@<path>@` template form. Used by inputs that consume a raw path rather
   * than a rendered template — e.g. the Condition node's "Field path".
   */
  bare?: boolean;
};

/**
 * The surface the popover opens beside: the innermost dialog the picker is
 * rendered inside, found from the trigger.
 *
 * This used to be a Tailwind offset each call site passed in by hand (`ml-72`
 * for a standard dialog, `ml-96` for the 1.6×-wide `WideOverlayPanel`) — a
 * measurement of the dialog, guessed by the caller, restated in four prop
 * doc-comments. Three of eight call sites had it wrong, and a `VariableTextarea`
 * had no way to pass it at all. The dialog knows its own width, so ask it:
 * `closest` naturally finds the INNERMOST dialog, which is exactly the nested
 * `WideOverlayPanel` case the constants were hand-encoding.
 *
 * Returns null when the picker isn't inside a dialog, and the popover falls back
 * to Radix's default of anchoring to the trigger.
 */
function enclosingDialog(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? null;
}

/** Strips the `@<path>@` template wrapper down to the bare dotted path. */
function toBarePath(insertText: string): string {
  return insertText.replace(/^@<\s*/, "").replace(/\s*>@$/, "");
}

/** Shared stand-in for every list a closed picker doesn't build, at one identity. */
const EMPTY: never[] = [];

/**
 * The popover's height, owned by the panel shell rather than by either panel's
 * content: the fields panel covers the node list (`absolute inset-0`), so
 * whichever one sizes the box sizes the other. Fixed, so drilling in and back
 * never resizes or moves it — the same reason the popover is pinned to a fixed
 * anchor.
 */
const PANEL_HEIGHT = "h-[min(22rem,60vh)]";

/**
 * A panel's title bar. Both panels get one, with the same red cross every other
 * overlay in the app uses — on the node list it closes the picker, on a source's
 * fields it steps back to the node list.
 */
const PanelHeader = ({
  title,
  onClose,
  closeLabel,
}: {
  title: string;
  onClose: () => void;
  closeLabel?: string;
}) => (
  <div className="relative border-b px-8 py-2 text-center text-sm font-medium">
    <span className="line-clamp-2 break-words">{title}</span>
    <OverlayCloseAction
      className="top-1.5 right-1.5"
      onClick={onClose}
      aria-label={closeLabel}
    />
  </div>
);

/**
 * A panel's scrollable body. Fills whatever its panel's header leaves, so the
 * height belongs to the shell (`PANEL_HEIGHT`) and neither panel's own content
 * can decide how big the popover is.
 */
const PanelBody = ({ children }: { children: ReactNode }) => (
  <div
    className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
    onWheel={(e) => {
      // The parent modal Dialog's scroll-lock (react-remove-scroll) blocks
      // wheel/trackpad scrolling on this portaled popover, so drive the scroll
      // manually — two-finger scrolling now works (dragging the scrollbar
      // already did).
      e.currentTarget.scrollTop += e.deltaY;
    }}
  >
    {children}
  </div>
);

/** One source on the first panel: a node, or a group the current node owns. */
const SourceRow = ({
  source,
  onOpen,
}: {
  source: PickerSource;
  onOpen: () => void;
}) => (
  <li>
    <button
      type="button"
      // min-h-13 is the height of a two-line row (a named node, whose type sits
      // under its name). Rows with no subtitle — an unnamed trigger — hold that
      // same height instead of sitting shorter than the ones around them.
      className="flex min-h-13 w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted"
      onClick={onOpen}
    >
      {/* The slot is held even when the type has no registered icon (node-options
          is a partial registry with no compile backstop), so one unregistered
          node can't shift its label out of the column the others line up in. */}
      <span className="flex size-4 shrink-0 items-center justify-center">
        <NodeTypeIcon
          icon={
            source.nodeType
              ? nodeOptionByType[source.nodeType as NodeType]?.icon
              : undefined
          }
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium text-foreground">
          {source.label}
        </span>
        {source.sublabel ? (
          <span className="block break-words text-xs text-muted-foreground">
            {source.sublabel}
          </span>
        ) : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  </li>
);

/** One pickable field on the second panel: its friendly name over its path. */
const FieldRow = ({
  field,
  bare,
  onPick,
}: {
  field: PickerFieldRow;
  bare?: boolean;
  onPick: (inserted: string) => void;
}) => {
  const inserted = bare ? toBarePath(field.insertText) : field.insertText;
  return (
    <li>
      <button
        type="button"
        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
        onClick={() => onPick(inserted)}
      >
        <span className="font-medium text-foreground">{field.fieldLabel}</span>
        <span className="w-full break-all font-mono text-xs text-muted-foreground">
          {inserted}
        </span>
      </button>
    </li>
  );
};

/**
 * The "insert a field" picker, in two panels: the nodes a value can come from,
 * and — covering it — the fields of the one you picked. One node's fields at a
 * time, rather than every upstream field on a single scroll.
 */
export function VariablePicker({
  currentNodeId,
  onSelect,
  disabled,
  className,
  bare,
  currentValue,
  extraGroups = [],
}: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The dialog to open beside, resolved from the DOM when the picker opens. */
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  /** Which source's fields are showing, i.e. whether panel 2 is up. */
  const [openSourceKey, setOpenSourceKey] = useState<string | null>(null);

  // Read LIVE canvas state (not the saved server copy) so connections drawn a
  // moment ago are reflected immediately — no save required.
  const nodes = useNodes();
  const edges = useEdges();

  // None of the picker's model is built until it's actually open. A Sheets
  // column mapping holds one of these per column — dozens — and every one of
  // them re-renders on every keystroke in the dialog, while Radix unmounts the
  // content of all the closed ones. Computing this for them is pure waste, and
  // gating on `open` also sidesteps the question of memoizing a source list
  // whose `extraGroups` its call site rebuilds each render.
  const currentNode = open
    ? nodes.find((n) => n.id === currentNodeId)
    : undefined;
  // Custom features belong to the CURRENT node's type (not an upstream node),
  // and are meaningless for bare-path inputs (they insert a `@<custom:…>@`
  // token, not a dotted path).
  const customFeatures =
    open && !bare ? getCustomFeatures(currentNode?.type) : EMPTY;
  const rows = useMemo(
    () => (open ? getUpstreamFields(currentNodeId, nodes, edges) : EMPTY),
    [open, nodes, edges, currentNodeId],
  );
  const sources = open
    ? buildPickerSources({
        rows,
        currentNode,
        extraGroups,
        hasCustomFeatures: customFeatures.length > 0,
        labelForType: nodeTypeLabel,
      })
    : EMPTY;

  // A source can disappear from under an open panel — an undo removes the edge
  // that produced it — which falls back to the node list rather than a blank
  // panel.
  const activeSource = sources.find((s) => s.key === openSourceKey) ?? null;

  // Falling back in render isn't enough on its own: the key would still be set,
  // so if that same source came back (a redo) the panel would spring open over
  // the node list unbidden. Drop the key for real.
  const sourceIsGone = openSourceKey !== null && activeSource === null;
  useEffect(() => {
    if (sourceIsGone) setOpenSourceKey(null);
  }, [sourceIsGone]);

  const close = () => {
    setOpen(false);
    // Reopening always starts on the node list, so the picker reads the same way
    // every time rather than resuming wherever the last insert left it.
    setOpenSourceKey(null);
  };

  const pick = (inserted: string) => {
    onSelect(inserted);
    close();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      close();
      return;
    }
    // Resolved on open rather than on mount: a dialog renders its content only
    // while it is open, and a picker inside a WideOverlayPanel layered over
    // another dialog has to find the one it is in NOW.
    setAnchorEl(enclosingDialog(triggerRef.current));
    setOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
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
      {/* Anchoring to the whole dialog — with side="right" align="center" — is
          what puts the panel just off the dialog's right edge, vertically
          centered, in the SAME place every time regardless of which field's
          button was clicked. With no dialog to anchor to, Radix falls back to
          the trigger, which is the sane place for a picker outside one. */}
      {anchorEl ? <PopoverAnchor virtualRef={{ current: anchorEl }} /> : null}
      <PopoverContent
        side="right"
        align="center"
        sideOffset={16}
        collisionPadding={16}
        className="w-80 overflow-hidden border-primary/60 p-0"
        // Escape mirrors the two crosses rather than always dismissing: from a
        // fields panel it steps back to the node list, and only from the node
        // list does it close the picker. Otherwise the keyboard has no
        // equivalent of the back-step and loses your place in the list.
        onEscapeKeyDown={(event) => {
          if (!activeSource) return;
          event.preventDefault();
          setOpenSourceKey(null);
        }}
      >
        {sources.length === 0 ? (
          <>
            <PanelHeader title="Insert a field" onClose={close} />
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No previous steps are connected before this one yet.
            </div>
          </>
        ) : (
          <div className={cn("relative flex flex-col", PANEL_HEIGHT)}>
            <PanelHeader title="Insert a field" onClose={close} />
            <PanelBody>
              <ul>
                {sources.map((source) => (
                  <SourceRow
                    key={source.key}
                    source={source}
                    onOpen={() => setOpenSourceKey(source.key)}
                  />
                ))}
              </ul>
            </PanelBody>
            {activeSource ? (
              // Covers the node list completely, at the same size, so it reads
              // as a second picker laid over the first.
              <div className="absolute inset-0 flex flex-col bg-popover">
                <PanelHeader
                  title={activeSource.label}
                  onClose={() => setOpenSourceKey(null)}
                  closeLabel="Back to the list of nodes"
                />
                <PanelBody>
                  <ul>
                    {activeSource.kind === "custom"
                      ? customFeatures.map((feature) => (
                          <CustomFeatureEntry
                            key={feature.id}
                            feature={feature}
                            currentValue={currentValue}
                            onInsert={pick}
                          />
                        ))
                      : activeSource.fields.map((field) => (
                          <FieldRow
                            key={field.insertText}
                            field={field}
                            bare={bare}
                            onPick={pick}
                          />
                        ))}
                  </ul>
                </PanelBody>
              </div>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
