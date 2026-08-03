"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_MAX_FAN_OUT_ITEMS,
  DEFAULT_ON_ITEM_FAILURE,
  MAX_FAN_OUT_ITEMS_LIMIT,
  type MultiMatchMode,
  ON_ITEM_FAILURE_MODES,
  type OnItemFailure,
} from "@/lib/multi-match";

/**
 * Shared "what happens when more than one matches?" control for node dialogs.
 * UI counterpart of the multi-match policy in `src/lib/multi-match.ts` — the
 * values map 1:1 onto a node's saved `onMultipleMatches` / `maxFanOutItems`
 * config keys. Drop it into any list-producing node's dialog; `itemNoun` names
 * one item ("row", "message", …) and must pluralize with a plain "s".
 */

const DESCRIPTIONS: Record<MultiMatchMode, (noun: string) => string> = {
  first: (noun) =>
    `Continue with the topmost matching ${noun} — reference its values via the “(matched ${noun})” fields.`,
  last: (noun) =>
    `Continue with the bottom-most matching ${noun} — the same “(matched ${noun})” fields, resolved to the last match instead of the first.`,
  each: (noun) =>
    `Start one run per matching ${noun}; the following steps run once for each, and the “(matched ${noun})” fields hold that run's ${noun}.`,
  error: (noun) => `Stop the workflow if more than one ${noun} matches.`,
};

/**
 * Labels and help text for the item-failure modes, keyed by the enum so adding
 * a mode to `ON_ITEM_FAILURE_MODES` is a compile error here rather than a
 * silently missing option — the same idiom as `DESCRIPTIONS` above.
 */
const ITEM_FAILURE_COPY: Record<
  OnItemFailure,
  { label: (noun: string) => string; help: (noun: string) => string }
> = {
  continue: {
    label: (noun) => `Keep going with the remaining ${noun}s`,
    help: (noun) =>
      `The failed ${noun} is recorded as failed and the next one still runs.`,
  },
  stop: {
    label: () => "Stop — don't start the rest",
    help: (noun) =>
      `The ${noun}s after the failed one never start. The failed run says how many were skipped.`,
  },
};

/** The settings that apply to a fan-out once it IS one. */
export interface FanOutCapProps {
  maxItems: number | undefined;
  /** `undefined` = "use the default cap" (an empty input is a valid state). */
  onMaxItemsChange: (n: number | undefined) => void;
  onItemFailure: OnItemFailure | undefined;
  onItemFailureChange: (mode: OnItemFailure) => void;
  itemNoun?: string;
}

interface Props extends FanOutCapProps {
  mode: MultiMatchMode | undefined;
  onModeChange: (mode: MultiMatchMode) => void;
}

/**
 * Every setting that applies to a fan-out once it IS one: the `maxFanOutItems`
 * cap and the `onItemFailure` policy.
 *
 * Exported on its own for nodes that fan out but do NOT choose between
 * first/each/error — the Sheets insert action, whose modes are about WHERE the
 * row lands, not which match to keep. `MultiMatchSelect` nests it under "each",
 * so both fan-out entry points offer the identical pair of controls with the
 * same keys and clamping.
 */
export const FanOutCapInput = ({
  maxItems,
  onMaxItemsChange,
  onItemFailure,
  onItemFailureChange,
  itemNoun = "item",
}: FanOutCapProps) => (
  <div className="space-y-4">
    <div className="space-y-2">
      <Label>Max {itemNoun}s</Label>
      <Input
        type="number"
        min={1}
        max={MAX_FAN_OUT_ITEMS_LIMIT}
        placeholder={String(DEFAULT_MAX_FAN_OUT_ITEMS)}
        value={maxItems ?? ""}
        onChange={(e) => {
          // Empty = "use the default" (a valid saved state). Typed values are
          // clamped into the schema's range so the form can never sit in an
          // invalid state that silently blocks Save.
          const raw = e.target.value;
          if (raw === "") {
            onMaxItemsChange(undefined);
            return;
          }
          const n = Math.trunc(Number(raw));
          if (Number.isFinite(n)) {
            onMaxItemsChange(Math.min(MAX_FAN_OUT_ITEMS_LIMIT, Math.max(1, n)));
          }
        }}
      />
      <p className="text-xs text-muted-foreground">
        Safety cap on how many runs one match may start (default{" "}
        {DEFAULT_MAX_FAN_OUT_ITEMS}).
      </p>
    </div>

    <div className="space-y-2">
      <Label>If one {itemNoun} fails</Label>
      <Select
        value={onItemFailure ?? DEFAULT_ON_ITEM_FAILURE}
        onValueChange={(v) => onItemFailureChange(v as OnItemFailure)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ON_ITEM_FAILURE_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {ITEM_FAILURE_COPY[m].label(itemNoun)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {ITEM_FAILURE_COPY[onItemFailure ?? DEFAULT_ON_ITEM_FAILURE].help(
          itemNoun,
        )}
      </p>
    </div>
  </div>
);

export const MultiMatchSelect = ({
  mode,
  onModeChange,
  // Rest, not named props: every fan-out setting belongs to FanOutCapProps and
  // is forwarded untouched, so adding one needs no change here.
  ...fanOutProps
}: Props) => {
  const value = mode ?? "first";
  const itemNoun = fanOutProps.itemNoun ?? "item";

  return (
    <div className="space-y-2">
      <Label>When multiple {itemNoun}s match</Label>
      <Select
        value={value}
        onValueChange={(v) => onModeChange(v as MultiMatchMode)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="first">Use first {itemNoun}</SelectItem>
          <SelectItem value="last">Use last {itemNoun}</SelectItem>
          <SelectItem value="each">
            Run following steps once per {itemNoun}
          </SelectItem>
          <SelectItem value="error">Fail the run</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {DESCRIPTIONS[value](itemNoun)}
      </p>
      {value === "each" && (
        <div className="pt-1">
          <FanOutCapInput {...fanOutProps} itemNoun={itemNoun} />
        </div>
      )}
    </div>
  );
};
