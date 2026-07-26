"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_ROW_SCOPE,
  ROW_SCOPE_LABELS,
  ROW_SCOPES,
  type RowScope,
} from "@/lib/sheet-heading";

/**
 * "Which kind of row does this apply to?" — the one picker for the
 * data / headings / all choice, shared by the Sheets ACTION (where it scopes what
 * a conditions filter may touch) and the Sheets TRIGGER (where it scopes what
 * fires a run).
 *
 * A heading row is structurally an ordinary row — merging is only a display
 * effect and its text sits in column A — so without this distinction a filter
 * matching a section title would overwrite it, and editing one would fire the
 * trigger as though data had changed. This is also the only way to deliberately
 * target headings.
 *
 * Lives here rather than in either dialog because two copies of the choice would
 * be two places for "what counts as a heading" to drift apart in the UI, while
 * the poller and the executor already share one definition (`headingDataRows`).
 */
export function RowScopeSelect({
  value,
  onChange,
  itemNoun,
  label,
  describe,
}: {
  value: RowScope | undefined;
  onChange: (next: RowScope) => void;
  /** What happens to the rows selected, e.g. "changed", "colored", "watched". */
  itemNoun: string;
  /** Overrides the "Which rows can be {itemNoun}" heading. */
  label?: string;
  /**
   * Overrides the caption under the select. The default is written for an action
   * that WRITES to the rows it picks; a caller whose scope means something else
   * (the trigger, which only watches) supplies its own rather than bending the
   * `itemNoun` phrasing to fit.
   */
  describe?: (scope: RowScope) => string;
}) {
  const scope = value ?? DEFAULT_ROW_SCOPE;
  return (
    <div className="space-y-2">
      <Label>{label ?? `Which rows can be ${itemNoun}`}</Label>
      <Select value={scope} onValueChange={(v) => onChange(v as RowScope)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROW_SCOPES.map((s) => (
            <SelectItem key={s} value={s}>
              {ROW_SCOPE_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {describe
          ? describe(scope)
          : scope === "headings"
            ? `Only heading rows are ${itemNoun} — the merged section titles, never your data.`
            : scope === "all"
              ? `Both data and heading rows can be ${itemNoun}. A filter matching a heading's text will change the section title itself.`
              : `Heading rows are skipped, so a filter can never ${
                  itemNoun === "changed" ? "overwrite" : "repaint"
                } a section title by accident.`}
      </p>
    </div>
  );
}
