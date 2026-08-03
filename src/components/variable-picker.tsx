"use client";

import { useEdges, useNodes } from "@xyflow/react";
import { Braces, ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  filterPickerSources,
  getUpstreamFields,
  type PickerExtraGroup,
  type PickerFieldRow,
  type PickerSource,
  toBarePath,
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
  /**
   * Controls the popover from outside — how a variable field raises it on focus,
   * and how the typed `@<` shortcut does. Left undefined, the picker owns its own
   * open state and only the braces button opens it.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * The field this picker belongs to, which puts it in FIELD MODE. Three things
   * follow from it, and they are one behaviour rather than three settings:
   *
   *   - No braces button. Focusing the field is what opens the panel, so a
   *     button to open it would be a second way to do the same thing, sitting
   *     permanently on top of the text.
   *   - Clicks inside this element don't dismiss it — clicking back into your
   *     own text to move the caret must not take the panel away.
   *   - Picking a value leaves the panel up, so several can go in without
   *     reopening it once per value.
   *
   * Omitted, the picker is the standalone button it has always been: the
   * Calculator's keypad key and the Code node's "insert a value" row, neither of
   * which has a variable field to attach to.
   */
  attachedTo?: React.RefObject<HTMLElement | null>;
  /**
   * What the user has typed since `@<`, or null when the caret is not inside an
   * unfinished reference.
   *
   * The distinction between null and `""` is load-bearing. `""` means the
   * trigger was just typed: the panel shows everything, but the user is mid-
   * reference, so ↑/↓/Enter now belong to the panel. `null` means ordinary
   * prose, where those keys must go on moving the caret and inserting newlines.
   */
  query?: string | null;
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

/**
 * Keeps the keyboard-highlighted row in view, and does nothing at all to the
 * others — `block: "nearest"` so walking the list scrolls by one row rather than
 * yanking the highlighted row to the middle of the panel.
 */
const useScrollIntoView = (active: boolean) =>
  useCallback(
    (el: HTMLElement | null) => {
      if (active) el?.scrollIntoView({ block: "nearest" });
    },
    [active],
  );

/** The one style that says "Enter takes this", shared by both panels' rows. */
const HIGHLIGHT_CLASS = "bg-muted";

/** One source on the first panel: a node, or a group the current node owns. */
const SourceRow = ({
  source,
  active,
  onOpen,
}: {
  source: PickerSource;
  active: boolean;
  onOpen: () => void;
}) => (
  <li>
    <button
      type="button"
      ref={useScrollIntoView(active)}
      // min-h-13 is the height of a two-line row (a named node, whose type sits
      // under its name). Rows with no subtitle — an unnamed trigger — hold that
      // same height instead of sitting shorter than the ones around them.
      className={cn(
        "flex min-h-13 w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted",
        active && HIGHLIGHT_CLASS,
      )}
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
  active,
  onPick,
}: {
  field: PickerFieldRow;
  bare?: boolean;
  active: boolean;
  onPick: (inserted: string) => void;
}) => {
  const inserted = bare ? toBarePath(field.insertText) : field.insertText;
  return (
    <li>
      <button
        type="button"
        ref={useScrollIntoView(active)}
        className={cn(
          "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
          active && HIGHLIGHT_CLASS,
        )}
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
  // Defaulted to the shared EMPTY rather than a fresh `[]`, so a caller that
  // passes nothing gives the memos below a stable identity to rest on.
  extraGroups = EMPTY,
  open: controlledOpen,
  onOpenChange,
  attachedTo,
  query = null,
}: VariablePickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Whether this opening came from the braces button. A picker summoned by
   * typing `@<` must NOT pull focus out of the field mid-sentence — see the
   * PopoverContent below — while one opened by clicking the button should
   * behave like any other popover and take focus.
   */
  const openedByTrigger = useRef(false);
  /**
   * The dialog to open beside, resolved from the DOM the first render the
   * picker is open — a ref rather than state because the popover positions
   * itself in that same render, and a state update landing an effect later
   * would paint one frame at the wrong place.
   */
  const anchorRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    // Resolved on each open rather than on mount: a dialog renders its content
    // only while it is open, and a picker inside a WideOverlayPanel layered over
    // another dialog has to find the one it is in NOW. The last anchor is kept
    // once closed so the exit animation doesn't jump to the trigger.
    //
    // In field mode there is no trigger button to search up from, so the search
    // starts at the field itself — which sits in the same dialog the button did.
    anchorRef.current = enclosingDialog(
      attachedTo?.current ?? triggerRef.current,
    );
  }
  wasOpen.current = open;
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
  const hasCustomFeatures = customFeatures.length > 0;
  const allSources = useMemo(
    () =>
      open
        ? buildPickerSources({
            rows,
            currentNode,
            extraGroups,
            hasCustomFeatures,
            labelForType: nodeTypeLabel,
          })
        : EMPTY,
    [open, rows, currentNode, extraGroups, hasCustomFeatures],
  );

  // Narrowed to what the half-typed `@<…` can still become. A null query (the
  // caret is not inside a reference) shows everything.
  //
  // Memoized on the query: the panel also re-renders on every ↑/↓ (the highlight
  // is state), and re-filtering every field of every upstream node to produce
  // the identical list is the one part of that render worth avoiding.
  const sources = useMemo(
    () => (query ? filterPickerSources(allSources, query) : allSources),
    [allSources, query],
  );

  /**
   * The one source a query has narrowed down to, opened without being asked.
   *
   * Once nothing else can match, the node list is a list of one — a click that
   * only ever has one answer. Going straight to its values is what makes typing
   * `@<OG_S` land where the user was already heading. Derived rather than
   * stored, so a keystroke that widens the query again (a backspace) walks back
   * out of the node just as readily as it walked in.
   */
  const autoSourceKey =
    query && sources.length === 1 ? (sources[0]?.key ?? null) : null;

  // A source can disappear from under an open panel — an undo removes the edge
  // that produced it, or the query no longer matches it — which falls back to
  // the node list rather than a blank panel.
  const activeSource =
    sources.find((s) => s.key === (openSourceKey ?? autoSourceKey)) ?? null;

  // Falling back in render isn't enough on its own: the key would still be set,
  // so if that same source came back (a redo) the panel would spring open over
  // the node list unbidden. Drop the key for real. Checked against the filtered
  // list, so a manual pick that the query has since ruled out is dropped too.
  const sourceIsGone =
    openSourceKey !== null && !sources.some((s) => s.key === openSourceKey);
  useEffect(() => {
    if (sourceIsGone) setOpenSourceKey(null);
  }, [sourceIsGone]);

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const close = () => {
    setOpen(false);
    openedByTrigger.current = false;
    // Reopening always starts on the node list, so the picker reads the same way
    // every time rather than resuming wherever the last insert left it.
    setOpenSourceKey(null);
  };

  const pick = (inserted: string) => {
    onSelect(inserted);
    // Field mode keeps the panel up: you are still in the field, and a panel
    // that vanished on every insert would have to be summoned again to add the
    // second value to the same sentence. The open source stays open too, so
    // two fields of one step are two clicks, not two round trips through the
    // node list. A button-mode picker still closes — there the panel was
    // summoned FOR this one pick.
    if (!attachedTo) close();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      close();
      return;
    }
    // Radix only asks to open from an interaction with the trigger.
    openedByTrigger.current = true;
    setOpen(true);
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // The panel is navigable without leaving the field, which is the whole point
  // of narrowing by typing: a reference gets built in one unbroken run of
  // keystrokes.
  //
  // Whichever list is showing is the one the arrows walk. A custom-feature group
  // is deliberately not navigable — its entries take typed parameters before
  // they mean anything, so there is nothing for Enter to insert.
  const navigable =
    activeSource === null
      ? sources
      : activeSource.kind === "fields"
        ? activeSource.fields
        : EMPTY;

  const [highlight, setHighlight] = useState(0);
  // Any change to what is listed invalidates the position in it — after a
  // keystroke narrows the list, index 3 is a different row (or none).
  const listKey = `${query ?? ""}::${activeSource?.key ?? ""}`;
  const lastListKey = useRef(listKey);
  if (lastListKey.current !== listKey) {
    lastListKey.current = listKey;
    if (highlight !== 0) setHighlight(0);
  }
  const active = Math.min(highlight, Math.max(navigable.length - 1, 0));

  const acceptHighlighted = () => {
    if (activeSource === null) {
      const source = sources[active];
      if (source) setOpenSourceKey(source.key);
      return;
    }
    if (activeSource.kind !== "fields") return;
    const field = activeSource.fields[active];
    if (field) pick(bare ? toBarePath(field.insertText) : field.insertText);
  };

  // Bound to the document rather than to the panel: focus is in the FIELD the
  // whole time (that is what keeps typing working), so the panel never receives
  // a key event of its own. Capture phase, so Enter is intercepted before the
  // form submits or a textarea takes a newline.
  //
  // Two gates, both load-bearing:
  //   - `query !== null` — only while the caret sits inside an unfinished `@<…`
  //     do these three keys belong to the panel. In ordinary prose ↑/↓ must
  //     still move the caret through a textarea's lines, and Enter must still do
  //     what Enter does.
  //   - `attachedTo` — a document-wide capture listener is only ever safe when
  //     it can tell which keystrokes are its own, and the target check below
  //     needs that element to do it. A BUTTON-mode picker has no field to test
  //     against, so it must not listen at all: the Calculator's picker is a
  //     keypad key whose display is a separate control, and without this it
  //     would swallow Enter for the whole dialog — including on the focused
  //     Save button.
  const keyboardActive = open && query !== null && attachedTo != null;
  // `active`, not raw `highlight` — the handler then moves from the position the
  // user can SEE, so it needs no clamping of its own.
  const stateRef = useRef({ navigable, active, acceptHighlighted });
  stateRef.current = { navigable, active, acceptHighlighted };
  useEffect(() => {
    if (!keyboardActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The listener is on the document, so it has to confirm the keystroke came
      // from ITS field. Two pickers can overlap for a moment while focus moves
      // between fields — the one being dismissed must not answer for the one
      // being typed into. Field mode is guaranteed by `keyboardActive`, so a
      // missing element here means the field has unmounted: answer for nothing.
      const field = attachedTo?.current;
      if (
        !field ||
        !(event.target instanceof Node && field.contains(event.target))
      ) {
        return;
      }
      const {
        navigable: items,
        active: from,
        acceptHighlighted: accept,
      } = stateRef.current;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (items.length === 0) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        // Wraps, so holding one arrow reaches every row without having to know
        // which end of the list you started from.
        setHighlight((from + step + items.length) % items.length);
        return;
      }
      if (event.key === "Enter") {
        // Swallowed even with nothing to accept: mid-reference, Enter must never
        // fall through and submit the dialog on a half-typed token.
        event.preventDefault();
        accept();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [keyboardActive, attachedTo]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {attachedTo ? null : (
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
      )}
      {/* Anchoring to the whole dialog — with side="right" align="center" — is
          what puts the panel just off the dialog's right edge, vertically
          centered, in the SAME place every time regardless of which field's
          button was clicked. With no dialog to anchor to, Radix falls back to
          the trigger, which is the sane place for a picker outside one. */}
      {(anchorRef.current ?? attachedTo?.current) ? (
        <PopoverAnchor
          virtualRef={{
            // With no dialog to anchor to, field mode falls back to the field
            // rather than to Radix's default — there is no trigger button left
            // for that default to find.
            current: (anchorRef.current ?? attachedTo?.current) as HTMLElement,
          }}
        />
      ) : null}
      <PopoverContent
        side="right"
        align="center"
        sideOffset={16}
        collisionPadding={16}
        className="w-80 overflow-hidden border-primary/60 p-0"
        // Typing `@<` opens the picker without interrupting the sentence: focus
        // stays in the field, so the next keystroke still lands there and the
        // panel simply waits beside it.
        onOpenAutoFocus={(event) => {
          if (!openedByTrigger.current) event.preventDefault();
        }}
        // In field mode the panel belongs to the field for as long as the user
        // is IN the field, so its own clicks and focus must not dismiss it —
        // clicking back into your text to fix a word, or landing back in the
        // input after an insert, would otherwise take the panel away mid-
        // sentence. Everything genuinely elsewhere (another field, a dropdown,
        // the dialog's chrome) still dismisses, which is what hands the panel
        // over when the next field is focused.
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (
            attachedTo?.current &&
            target instanceof Node &&
            attachedTo.current.contains(target)
          ) {
            event.preventDefault();
          }
        }}
        // Escape mirrors the two crosses rather than always dismissing: from a
        // fields panel it steps back to the node list, and only from the node
        // list does it close the picker. Otherwise the keyboard has no
        // equivalent of the back-step and loses your place in the list. A panel
        // the QUERY drilled into has no back-step to take — stepping out of it
        // would leave a node list of one that the next render walks straight
        // back into — so there Escape closes.
        onEscapeKeyDown={(event) => {
          if (!activeSource || openSourceKey === null) return;
          event.preventDefault();
          setOpenSourceKey(null);
        }}
      >
        {sources.length === 0 ? (
          <>
            <PanelHeader title="Insert a field" onClose={close} />
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query ? (
                <>
                  Nothing starts with{" "}
                  <span className="break-all font-mono text-foreground">
                    {query}
                  </span>
                  .
                </>
              ) : (
                "No previous steps are connected before this one yet."
              )}
            </div>
          </>
        ) : (
          <div className={cn("relative flex flex-col", PANEL_HEIGHT)}>
            <PanelHeader title="Insert a field" onClose={close} />
            <PanelBody>
              <ul>
                {sources.map((source, index) => (
                  <SourceRow
                    key={source.key}
                    source={source}
                    active={activeSource === null && index === active}
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
                  // A panel the query drilled into on its own has nothing to go
                  // back TO, so the cross closes the picker instead of dropping
                  // the user on a node list holding only this node.
                  onClose={
                    openSourceKey === null
                      ? close
                      : () => setOpenSourceKey(null)
                  }
                  closeLabel={
                    openSourceKey === null
                      ? "Close"
                      : "Back to the list of nodes"
                  }
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
                      : activeSource.fields.map((field, index) => (
                          <FieldRow
                            key={field.insertText}
                            field={field}
                            bare={bare}
                            active={index === active}
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
