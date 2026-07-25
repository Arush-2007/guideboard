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
  MAX_FAN_OUT_ITEMS_LIMIT,
  type MultiMatchMode,
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

interface Props {
  mode: MultiMatchMode | undefined;
  onModeChange: (mode: MultiMatchMode) => void;
  maxItems: number | undefined;
  /** `undefined` = "use the default cap" (an empty input is a valid state). */
  onMaxItemsChange: (n: number | undefined) => void;
  itemNoun?: string;
}

/**
 * The `maxFanOutItems` cap on its own, for nodes that fan out but do NOT choose
 * between first/each/error — the Sheets insert action, whose modes are about
 * WHERE the row lands, not which match to keep. Same key, same clamping, so the
 * cap behaves identically wherever it is offered.
 */
export const FanOutCapInput = ({
  maxItems,
  onMaxItemsChange,
  itemNoun = "item",
}: Pick<Props, "maxItems" | "onMaxItemsChange" | "itemNoun">) => (
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
);

export const MultiMatchSelect = ({
  mode,
  onModeChange,
  maxItems,
  onMaxItemsChange,
  itemNoun = "item",
}: Props) => {
  const value = mode ?? "first";

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
          <FanOutCapInput
            maxItems={maxItems}
            onMaxItemsChange={onMaxItemsChange}
            itemNoun={itemNoun}
          />
        </div>
      )}
    </div>
  );
};
