"use client";

import { createId } from "@paralleldrive/cuid2";
import { Plus, Trash2 } from "lucide-react";
import { MatchingOptions } from "@/components/matching-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { VariableInput } from "@/components/variable-input";
import type { RowMatchCondition } from "@/lib/row-match";
import {
  MERGED_ROW_COLUMN,
  MERGED_ROW_COLUMN_LABEL,
  ROW_MATCH_OPERATOR_LABELS,
  ROW_MATCH_OPERATORS,
  VALUELESS_ROW_MATCH_OPERATORS,
} from "@/lib/row-match-operators";
import { cn } from "@/lib/utils";

export type RowMatchConditionsProps = {
  value: RowMatchCondition[];
  onChange: (next: RowMatchCondition[]) => void;
  currentNodeId: string;
  workflowId?: string;
  /**
   * When given, the column field is a Select of these headers; otherwise a free
   * text input (for tabs whose headers aren't loaded).
   */
  columnOptions?: string[];
  /**
   * Offer "Merged row" above the headers — a pseudo-column matching rows whose
   * cells are joined (section titles), comparing against the merged cell's text.
   *
   * Opt-in so this stays a generic conditions editor: only a caller whose
   * matcher is given the tab's merge ranges can honour it, and a condition the
   * matcher can't answer would silently match nothing (it fails closed). It also
   * needs the Select, since a free-text column field can't offer a choice.
   */
  allowMergedColumn?: boolean;
};

/** A fresh condition, with a stable UI id for React keys. */
export const newRowCondition = (): RowMatchCondition => ({
  id: createId(),
  column: "",
  operator: "equals",
  value: "",
  enabled: true,
});

/**
 * Shared "match rows where…" editor for the Sheets row-selection actions
 * (find_rows, update_row, style_cells). A CONTROLLED list of AND-ed
 * conditions — the parent owns the array and wires it like `FieldMapping`. Each
 * row picks a column, a RowMatchOperator, and (unless the operator takes no
 * value) a value via the variable picker, plus an enable toggle.
 *
 * Operator metadata comes from the dependency-free `row-match-operators.ts` and
 * only the `RowMatchCondition` TYPE from `row-match.ts`, so this client bundle
 * never pulls in the Handlebars-backed templating engine.
 */
export function RowMatchConditions({
  value,
  onChange,
  currentNodeId,
  workflowId,
  columnOptions,
  allowMergedColumn,
}: RowMatchConditionsProps) {
  const update = (index: number, patch: Partial<RowMatchCondition>) => {
    onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };
  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };
  const add = () => onChange([...value, newRowCondition()]);

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No conditions — every row is returned.
        </p>
      ) : null}

      {value.map((condition, index) => {
        const showValue = !VALUELESS_ROW_MATCH_OPERATORS.has(
          condition.operator,
        );
        return (
          <div key={condition.id} className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  aria-label={`Condition ${index + 1} enabled`}
                  checked={condition.enabled !== false}
                  onCheckedChange={(enabled) => update(index, { enabled })}
                />
                Enabled
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(index)}
                aria-label={`Remove condition ${index + 1}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div
              className={cn(
                "grid items-start gap-2",
                showValue ? "grid-cols-[1fr_1fr_1.5fr]" : "grid-cols-2",
              )}
            >
              {columnOptions ? (
                <Select
                  value={condition.column}
                  onValueChange={(column) => update(index, { column })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Column" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Above the headers and separated, because it asks about
                        the row's STRUCTURE rather than naming one of its
                        columns. */}
                    {allowMergedColumn ? (
                      <>
                        <SelectItem value={MERGED_ROW_COLUMN}>
                          {MERGED_ROW_COLUMN_LABEL}
                        </SelectItem>
                        <SelectSeparator />
                      </>
                    ) : null}
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  placeholder="Column"
                  value={condition.column}
                  onChange={(e) => update(index, { column: e.target.value })}
                />
              )}

              <Select
                value={condition.operator}
                onValueChange={(operator) =>
                  update(index, {
                    operator: operator as RowMatchCondition["operator"],
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Operator" />
                </SelectTrigger>
                <SelectContent>
                  {ROW_MATCH_OPERATORS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {ROW_MATCH_OPERATOR_LABELS[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {showValue ? (
                <VariableInput
                  value={condition.value ?? ""}
                  onChange={(e) => update(index, { value: e.target.value })}
                  placeholder="Value or field"
                  currentNodeId={currentNodeId}
                  workflowId={workflowId}
                />
              ) : null}
            </div>

            <MatchingOptions
              operator={condition.operator}
              ignoreCase={condition.ignoreCase}
              ignoreChars={condition.ignoreChars}
              numeric={condition.numeric}
              onChange={(patch) => update(index, patch)}
              idPrefix={`row-cond-${condition.id ?? index}`}
            />
          </div>
        );
      })}

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="mr-1.5 size-3.5" />
        Add condition
      </Button>
    </div>
  );
}
