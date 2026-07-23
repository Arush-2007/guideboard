"use client";

import { useEffect, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Coerce user-entered hex text to a canonical lowercase `#rrggbb`, or null when
 * it can't be recovered. Accepts an optional leading `#` and 3- or 6-digit hex,
 * expanding the shorthand — so a committed value always satisfies the strict
 * `#rrggbb` shape callers validate against (and that Sheets expects), and never
 * a hash-less or half-typed string that would render one thing on the board and
 * fail to save.
 */
function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3
    ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
    : `#${h}`;
}

/**
 * A themed hex color picker: a swatch+hex trigger that opens a Popover with a
 * saturation board, hue slider (react-colorful), a hex field, and optional
 * one-click presets — all styled with our own tokens so it matches the rest of
 * the UI instead of the browser's native `<input type="color">` popup.
 *
 * Performance: react-colorful drives the board off its OWN internal state, so it
 * stays smooth while dragging without any per-move work from us. The live stream
 * (`onChange`) only updates LOCAL state here — the swatch/hex preview — which
 * re-renders just this component. The heavy parent form is written exactly once
 * per adjustment, on RELEASE (`onChangeEnd`), on a hex blur, on a preset click,
 * or when the popover closes. This is what keeps a big host form (e.g. a node
 * dialog) from re-rendering on every intermediate color.
 *
 * `value` is the committed source of truth; it's re-adopted whenever the parent
 * changes it for a reason other than our own edit (a reset, a cycled default).
 */
export function ColorPicker({
  value,
  onChange,
  label,
  presets,
  className,
}: {
  value: string;
  /** Called with the committed color — never on every intermediate drag value. */
  onChange: (color: string) => void;
  label?: string;
  /** Optional one-click swatches (e.g. a brand/status palette). */
  presets?: string[];
  /** Extra classes for the trigger button. */
  className?: string;
}) {
  const [local, setLocal] = useState(value);
  const [open, setOpen] = useState(false);
  // The hex field's in-progress text, or null when it just mirrors `local`. Kept
  // separate so a half-typed or malformed value never reaches `local` — which
  // drives the board and the swatches and must stay a valid color at all times.
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  // Adopt an externally-changed value. During a pick the parent only re-renders
  // on commit, so `value` is stable mid-drag and this never fights a live edit.
  useEffect(() => setLocal(value), [value]);

  const commit = (color: string) => {
    setLocal(color);
    onChange(color);
  };

  // Dedupe so a caller passing a repeated color renders one chip and gives each
  // a unique React key — this is a reusable primitive, so it can't assume the
  // palette it's handed is already distinct.
  const uniquePresets = presets ? [...new Set(presets)] : [];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing is a last-resort commit for any still-uncommitted change (e.g.
        // a value set then dismissed without a blur). Guarded on an actual
        // difference so a no-op open/close doesn't dirty the host form.
        if (!next && local !== value) onChange(local);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label ?? "Pick a color"}
          className={cn("font-mono text-xs", className)}
        >
          <span
            className="size-4 shrink-0 rounded-sm border"
            style={{ backgroundColor: local }}
            aria-hidden
          />
          {local}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-3">
        {/* Live moves stay LOCAL (onChange); the parent form is written only on
            release (onChangeEnd), so the board never lags a big host form. */}
        <HexColorPicker
          color={local}
          onChange={setLocal}
          onChangeEnd={commit}
          className="!h-40 !w-full"
        />

        <div className="flex items-center gap-2">
          <span
            className="size-5 shrink-0 rounded border"
            style={{ backgroundColor: local }}
            aria-hidden
          />
          <Input
            aria-label={`${label ?? "Color"} hex`}
            value={hexDraft ?? local}
            onChange={(e) => {
              const raw = e.target.value;
              setHexDraft(raw);
              // Move the board only while the text is a usable color; otherwise
              // leave `local` on the last valid one.
              const next = normalizeHex(raw);
              if (next) setLocal(next);
            }}
            // Commit the normalized hex on blur (making a brand hex pasteable
            // without a per-keystroke form write), or revert to the last valid
            // color if it can't be parsed — so an invalid string never persists.
            // A blur with no draft means the field was only tabbed through, so
            // there is nothing to commit.
            onBlur={() => {
              if (hexDraft === null) return;
              commit(normalizeHex(hexDraft) ?? local);
              setHexDraft(null);
            }}
            placeholder="#22c55e"
            className="h-8 font-mono text-xs"
          />
        </div>

        {uniquePresets.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {uniquePresets.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-label={`Use ${preset}`}
                onClick={() => commit(preset)}
                className="size-5 rounded border outline-none transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
                style={{ backgroundColor: preset }}
              />
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
