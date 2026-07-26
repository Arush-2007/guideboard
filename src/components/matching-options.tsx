"use client";

import type {
  FieldValues,
  Path,
  PathValue,
  UseFormReturn,
} from "react-hook-form";
import { RestraintsSection } from "@/components/restraints-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  describeCompareOptions,
  supportsNumericOption,
  supportsTextOptions,
} from "@/features/executions/lib/compare";

/** The three option fields, as they sit on a condition/case/rule config object. */
export type MatchingOptionsValue = {
  ignoreCase?: boolean;
  ignoreChars?: string;
  numeric?: boolean;
};

const MATCHING_OPTION_KEYS = ["ignoreCase", "ignoreChars", "numeric"] as const;

/**
 * Builds the `onChange` a react-hook-form dialog hands to `MatchingOptions`:
 * it fans each key of the emitted patch into `form.setValue`, at `prefix + key`
 * (`""` for a flat form, `` `cases.${i}.` `` / `` `rules.${i}.` `` for an
 * array field). One helper instead of the same ~18-line block copy-pasted into
 * every comparing dialog — the duplication that let the Sheets schema drift and
 * drop these fields. (RHF's typed paths are dynamic strings here, hence the
 * contained casts.)
 */
export function makeMatchingOptionsHandler<T extends FieldValues>(
  form: UseFormReturn<T>,
  prefix: string,
): (patch: MatchingOptionsValue) => void {
  return (patch) => {
    for (const key of MATCHING_OPTION_KEYS) {
      if (key in patch) {
        form.setValue(
          `${prefix}${key}` as Path<T>,
          patch[key] as PathValue<T, Path<T>>,
          { shouldDirty: true },
        );
      }
    }
  };
}

type Props = MatchingOptionsValue & {
  /** The condition's operator — gates which options are shown/relevant. */
  operator: string;
  /** Emits a partial patch (merge into the owning condition). */
  onChange: (patch: MatchingOptionsValue) => void;
  /** Unique-ifies the control ids/labels when many render on one screen. */
  idPrefix: string;
};

/**
 * Shared "matching options" control for every node that compares two values
 * (Condition, Switch, Sheets row-match, Candidate Scoring). Presentational and
 * state-agnostic — it takes the current values and emits patches, so it drops
 * into both the controlled `RowMatchConditions` list and the react-hook-form
 * dialogs alike.
 *
 * Collapsed by default so the common case (exact match) stays uncluttered;
 * when collapsed with options set, the trigger shows a one-line summary of
 * what's active (via `describeCompareOptions`) so a configured row is legible
 * at a glance without expanding. Renders nothing for operators the options
 * don't apply to, so it can be placed unconditionally.
 */
export function MatchingOptions({
  operator,
  ignoreCase,
  ignoreChars,
  numeric,
  onChange,
  idPrefix,
}: Props) {
  if (!supportsTextOptions(operator)) return null;
  const showNumeric = supportsNumericOption(operator);
  const summary = describeCompareOptions(
    { ignoreCase, ignoreChars, numeric },
    operator,
  );

  return (
    <RestraintsSection summary={summary}>
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor={`${idPrefix}-ignore-case`}
          className="text-xs font-normal"
        >
          Ignore case
        </Label>
        <Switch
          id={`${idPrefix}-ignore-case`}
          checked={ignoreCase === true}
          onCheckedChange={(checked) => onChange({ ignoreCase: checked })}
        />
      </div>

      {showNumeric ? (
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={`${idPrefix}-numeric`}
            className="text-xs font-normal"
          >
            Compare as number
            <span className="ml-1 text-muted-foreground">(0001 = 1)</span>
          </Label>
          <Switch
            id={`${idPrefix}-numeric`}
            checked={numeric === true}
            onCheckedChange={(checked) => onChange({ numeric: checked })}
          />
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={`${idPrefix}-ignore-chars`}
            className="text-xs font-normal"
          >
            Neglect characters
          </Label>
          <Input
            id={`${idPrefix}-ignore-chars`}
            value={ignoreChars ?? ""}
            onChange={(e) => onChange({ ignoreChars: e.target.value })}
            placeholder="e.g. - / space"
            className="h-8 w-40 font-mono text-xs"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Any character typed here (a space included) is stripped from both
          sides before comparing.
        </p>
      </div>
    </RestraintsSection>
  );
}
