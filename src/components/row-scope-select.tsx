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
} from "@/lib/sheet-style";

/**
 * "Which kind of row does this apply to?" — the picker for the
 * normal / merged / all choice.
 *
 * A merged row is structurally an ordinary row — merging is only a display
 * effect and its text sits in column A — so without this distinction, editing a
 * section title would fire the trigger as though data had changed. This is also
 * the only way to deliberately watch merged rows.
 *
 * Used by the Sheets TRIGGER only. The ACTION node expresses the same idea more
 * directly: a `MERGED_ROW_COLUMN` condition in the filter editor it already has,
 * which can say "a merged row whose text contains X" rather than only "merged
 * rows". Both sides still agree on what merged MEANS, because both derive it
 * from `mergedDataRows`.
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
  /** What happens to the rows selected, e.g. "watched". */
  itemNoun: string;
  /** Overrides the "Which rows can be {itemNoun}" label. */
  label?: string;
  /** Overrides the caption under the select. */
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
            ? `Only merged rows are ${itemNoun} — the section titles, never your data.`
            : scope === "all"
              ? `Both normal and merged rows are ${itemNoun}.`
              : `Merged rows are skipped, so only your data is ${itemNoun}.`}
      </p>
    </div>
  );
}
