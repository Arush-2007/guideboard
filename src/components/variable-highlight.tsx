"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { splitPlaceholders } from "@/lib/variable-field";

/**
 * Painting `@<path>@` tokens in the app's blue, inside a real `<input>` /
 * `<textarea>`.
 *
 * A form control can't colour part of its own value, so the text is rendered
 * twice: the control keeps the caret, selection, IME and native scrolling but
 * turns its own glyphs transparent, and this layer sits exactly on top drawing
 * the same string with the tokens picked out. The two must agree glyph for
 * glyph, which is why the caller hands the SAME `className` to both — a font,
 * size, padding or margin override has to land on the layer as well or the two
 * copies drift apart.
 *
 * The swap only happens for values that actually contain a token
 * (`hasPlaceholder`); an ordinary field is left as a plain, untouched control.
 */

/**
 * Applied to a control that CAN be highlighted, in both states.
 *
 * The base Input/Textarea animate `color` (`transition-[color,…]
 * duration-200`), which the highlight swap toggles. Left alone, deleting the
 * last character of a reference unmounts the layer instantly while the
 * control's own glyphs fade back in from transparent — the field looks EMPTY
 * for a fifth of a second on that keystroke — and typing the closing `>@`
 * double-draws the text for as long. Narrowing the transition drops `color`
 * while keeping the hover shadow and focus motion the controls animate.
 */
export const HIGHLIGHTABLE_CONTROL_CLASS = "transition-[box-shadow,transform]";

/**
 * Applied to the control underneath while the layer is up. `caret-foreground`
 * is not optional: the caret defaults to `currentColor`, so transparent text
 * would otherwise mean an invisible caret. Selected text stays transparent too
 * — the layer above draws it — while the selection band itself stays visible
 * behind it.
 */
export const HIGHLIGHTED_CONTROL_CLASS =
  "text-transparent caret-foreground selection:bg-primary/30 selection:text-transparent";

export type VariableHighlightProps = {
  value: string;
  /**
   * The control being mirrored. Its scroll offset is read from the DOM rather
   * than passed in: a control can scroll without any event the caller sees —
   * a right-aligned one opens already scrolled to the tail of a long value —
   * and a stale offset means visibly doubled text.
   */
  controlRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** Wrap like a textarea (false = a single non-wrapping line, like an input). */
  multiline?: boolean;
  /** The control's className, forwarded verbatim — see the note above. */
  className?: string;
};

export function VariableHighlight({
  value,
  controlRef,
  multiline,
  className,
}: VariableHighlightProps) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const textRef = React.useRef<HTMLDivElement>(null);
  /**
   * The control's scroll, and — for a right-aligned control — how far it has
   * pushed its text off its own left edge.
   *
   * A `text-right` input parks short text against its right edge, but once the
   * text outgrows the box it lays out from the left of its scroll area like any
   * other, which is where `scrollLeft` then measures from. So the gap is
   * `max(box − text, 0)` and the layer's offset is that gap minus the scroll.
   * Both halves are needed — neither number alone covers both regimes, which is
   * why this can't be expressed in CSS.
   */
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });

  const sync = React.useCallback(() => {
    const control = controlRef.current;
    const track = trackRef.current;
    const text = textRef.current;
    if (!control || !track || !text) return;
    // Read off the control rather than taken as a prop: alignment is the
    // control's own property, and a caller that passed `text-right` in its
    // className while forgetting to declare it here would get a right-aligned
    // control under a left-aligned overlay — tokens nowhere near the caret,
    // with no way for that caller to correct it.
    const align = getComputedStyle(control).textAlign;
    const rightAligned = !multiline && (align === "right" || align === "end");
    const gap = rightAligned
      ? Math.max(
          track.getBoundingClientRect().width -
            text.getBoundingClientRect().width,
          0,
        )
      : 0;
    const next = { x: gap - control.scrollLeft, y: -control.scrollTop };
    // Sub-pixel churn would re-render on every keystroke for nothing.
    setOffset((prev) =>
      Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5
        ? prev
        : next,
    );
  }, [controlRef, multiline]);

  // Before paint, so a keystroke never shows one frame of unaligned text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync on every value change
  React.useLayoutEffect(sync, [sync, value]);

  React.useEffect(() => {
    const control = controlRef.current;
    const track = trackRef.current;
    const text = textRef.current;
    if (!control || !track || !text) return;
    // The control scrolls for reasons no render sees: dragging, a wheel, or the
    // caret being scrolled into view after an insert.
    control.addEventListener("scroll", sync, { passive: true });
    // And it can be resized under us — the dialog reflowing, or a webfont
    // swapping in and changing how wide the text measures.
    const observer = new ResizeObserver(sync);
    observer.observe(track);
    observer.observe(text);
    return () => {
      control.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [controlRef, sync]);

  return (
    <div
      aria-hidden
      className={cn(
        // Stacked in the same grid cell as the control rather than positioned
        // with `inset-0`: the cell is the control's own box, so a margin or a
        // min-height in the shared className moves both copies together.
        "pointer-events-none col-start-1 row-start-1 overflow-hidden",
        // The transparent border stands in for the control's 1px one, which is
        // what keeps the two content boxes on the same pixel.
        "border border-transparent px-3 text-base md:text-sm",
        multiline ? "py-2" : "flex h-full items-center py-1",
        className,
        // Never inherited from the control's className: this layer paints the
        // text and must not repeat the control's own chrome.
        "bg-transparent shadow-none",
      )}
    >
      {/* The track is the control's content box — the width the offset maths
          measures against, and the box the text is clipped to. The text inside
          shrinks to its own width so it can be measured too, and is moved as
          one block.
          Clipping HERE rather than on the padded box above is the whole point:
          a control clips its text at its content edge, so the text must stop
          where the padding starts. Clipping one step further out let a long
          value paint across the padding the field reserves for the picker
          button — the text ran under the button while the caret, correctly,
          did not, so the end of the value looked unreachable.
          A textarea needs the same clip vertically, hence `h-full` there; a
          single line is already centred and clipped by the box above. */}
      <div
        ref={trackRef}
        className={cn("w-full overflow-hidden", multiline && "h-full")}
      >
        <div
          ref={textRef}
          className={
            multiline
              ? "whitespace-pre-wrap break-words"
              : // `shrink-0`: a flex item may not compress the text out of the
                // width it was measured at.
                "w-max shrink-0 whitespace-pre"
          }
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        >
          {splitPlaceholders(value).map((segment, index) =>
            segment.isToken ? (
              <span
                // Segments have no identity of their own — position in the split
                // IS the identity, and the whole layer re-renders per keystroke.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={index}
                // Colour and background only — NEVER weight, size, spacing or
                // any other metric-bearing property. The control underneath
                // draws the whole value at one weight, so a bolder token here
                // shifts every glyph after it out of step with the real text:
                // the caret, the selection band and click-to-place hit testing
                // all follow the control's metrics, not what you can see. This
                // was `font-medium`, which is invisible in the `font-mono`
                // fields (one advance width per glyph at any weight) and wrong
                // in every proportional one.
                className="rounded-[3px] bg-primary/10 text-primary"
              >
                {segment.text}
              </span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <span key={index} className="text-foreground">
                {segment.text}
              </span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
