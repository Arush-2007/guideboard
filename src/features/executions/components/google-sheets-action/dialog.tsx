"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createId } from "@paralleldrive/cuid2";
import { useQuery } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { FieldMapping } from "@/components/field-mapping";
import { MatchingOptions } from "@/components/matching-options";
import {
  FanOutCapInput,
  MultiMatchSelect,
} from "@/components/multi-match-select";
import {
  newRowCondition,
  RowMatchConditions,
} from "@/components/row-match-conditions";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { VariableInput } from "@/components/variable-input";
import type { PickerExtraGroup } from "@/components/variable-picker";
import { WideOverlayPanel } from "@/components/wide-overlay-panel";
import { NodeType } from "@/generated/prisma";
import { compareOptionsSchemaFields } from "@/lib/compare-options-schema";
import { MAX_FAN_OUT_ITEMS_LIMIT, MULTI_MATCH_MODES } from "@/lib/multi-match";
import { getOutputKeyForNode } from "@/lib/node-ref";
import {
  hasActiveRowCondition,
  ROW_MATCH_OPERATORS,
  type RowMatchOperator,
} from "@/lib/row-match-operators";
import { anchorRowPath, sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  DEFAULT_HEADING_FORMAT,
  HEADING_FONT_SIZE,
  HEADING_MATCH_MODE_LABELS,
  HEADING_MATCH_MODES,
  HEADING_MATCH_OPERATOR_LABELS,
  HEADING_MATCH_OPERATORS,
  type HeadingFilter,
  type HeadingFormat,
  type HeadingMatchMode,
  type HeadingMatchOperator,
  headingColorSchema,
  headingFilterSchema,
  headingFormatSchema,
  ROW_SCOPE_LABELS,
  ROW_SCOPES,
  type RowScope,
  resolveHeadingFilterOptions,
  resolveHeadingFormat,
} from "@/lib/sheet-heading";
import { useTRPC } from "@/trpc/client";

// Conditions editor value shape. Operator reuses the single ROW_MATCH_OPERATORS
// source (client-safe); `parseNodeConfig` on the server is the authoritative gate.
const rowConditionFormSchema = z.object({
  id: z.string().optional(),
  column: z.string(),
  operator: z.enum(
    ROW_MATCH_OPERATORS as [RowMatchOperator, ...RowMatchOperator[]],
  ),
  value: z.string().optional(),
  enabled: z.boolean().optional(),
  // Matching restraints — spread from the ONE shared fragment so this dialog's
  // resolver can't drop them on submit (a plain z.object() strips undeclared
  // keys), which is what made them fail to persist.
  ...compareOptionsSchemaFields,
});

// One color_rows rule. `conditions` reuses rowConditionFormSchema so the
// per-condition matching restraints survive submit here too (a plain z.object()
// would strip them — the dual-schema gotcha).
const colorRuleFormSchema = z.object({
  id: z.string().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, "Pick a color"),
  conditions: z.array(rowConditionFormSchema),
});

const formSchema = z
  .object({
    action: z.enum([
      "append_row",
      "append_heading",
      "find_rows",
      "find_heading",
      "update_row",
      "update_heading",
      "color_rows",
      "color_heading",
    ]),
    // Appending actions only: where the new row lands.
    position: z.enum(["bottom", "under_group", "under_each"]).optional(),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
    // Appending actions + bottom only: also leave a blank separator row above.
    blankRowAbove: z.boolean().optional(),
    // append_heading only. `headingFormat` reuses the ONE shared fragment so this
    // resolver can't strip a style field on submit (the dual-schema gotcha).
    headingText: z.string().optional(),
    headingFormat: headingFormatSchema.optional(),
    // find_heading only: the heading search. Optional — no value lists them all.
    headingFilter: headingFilterSchema.optional(),
    // update_row / color_rows / non-bottom append: which kind of row the filter
    // may select. Absent ⇒ "data".
    rowScope: z.enum(ROW_SCOPES).optional(),
    // update_heading only: also re-apply the style to the row it rewrites.
    restyleHeading: z.boolean().optional(),
    // color_heading only: the one colour every matching heading is painted.
    headingColor: headingColorSchema.optional(),
    // find_heading / color_heading: which of several matching headings to act on.
    onMultipleHeadings: z.enum(HEADING_MATCH_MODES).optional(),
    conditions: z.array(rowConditionFormSchema).optional(),
    // color_rows only: the ordered rule list (first match wins).
    colorRules: z.array(colorRuleFormSchema).optional(),
    // color_rows only: paint the topmost matched row ("first"), the bottom-most
    // ("last"), or every matched row ("all", the default). Declared here too so
    // the resolver keeps it on submit (a plain z.object() strips undeclared keys
    // — the dual-schema gotcha).
    onMultipleColorMatches: z.enum(["first", "last", "all"]).optional(),
    // Multi-match fields, built from the shared constants (see the NOTE on
    // multiMatchConfigFields for why the fragment itself can't be spread here).
    onMultipleMatches: z.enum(MULTI_MATCH_MODES).optional(),
    maxFanOutItems: z
      .number()
      .int()
      .min(1)
      .max(MAX_FAN_OUT_ITEMS_LIMIT)
      .optional(),
  })
  .superRefine((data, ctx) => {
    // The two READ actions need only a spreadsheet + tab (already required).
    // find_heading's search is optional — empty lists every heading.
    if (data.action === "find_rows" || data.action === "find_heading") return;

    // Mirrors the config schema: a heading update must actually do something.
    if (data.action === "update_heading") {
      if (!data.headingText?.trim() && data.restyleHeading !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Give the heading new text, or turn on “Also restyle it” — otherwise this step would change nothing",
          path: ["headingText"],
        });
      }
      return;
    }

    if (data.action === "color_heading") {
      if (!data.headingColor?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pick a color",
          path: ["headingColor"],
        });
      }
      return;
    }

    // color_rows uses neither columnMappings nor the shared `conditions` —
    // every rule carries its own filter. Mirrors the config schema's rule.
    if (data.action === "color_rows") {
      const rules = data.colorRules ?? [];
      if (rules.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Add at least one color rule",
          path: ["colorRules"],
        });
        return;
      }
      rules.forEach((rule, i) => {
        if (!hasActiveRowCondition(rule.conditions)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Add at least one condition — a rule with an empty filter would color every row",
            path: ["colorRules", i, "conditions"],
          });
        }
      });
      return;
    }

    // Both appending actions place their row the same way, so the filter rule
    // below applies to either one in a non-bottom position.
    const isUnderAppend =
      (data.action === "append_row" || data.action === "append_heading") &&
      (data.position ?? "bottom") !== "bottom";

    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;

    // append_heading writes one cell, not a mapping — its text is what must be
    // there. Mirrors the config schema's rule.
    if (data.action === "append_heading" && !data.headingText?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Heading text is required",
        path: ["headingText"],
      });
    }

    // update_row must map at least one column — with none it writes nothing.
    // append_row needs NO mapping in any position: leaving every column blank
    // appends a blank row, which is allowed.
    if (data.action === "update_row" && !hasMappings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Map at least one column to update",
        path: ["columnMappings"],
      });
    }

    // Both write cases need a real filter: with none, every row "matches" —
    // update_row would overwrite the whole sheet, and an under-append would have
    // no meaningful group to join. Mirrors the config schema's rule.
    if (
      (data.action === "update_row" || isUnderAppend) &&
      !hasActiveRowCondition(data.conditions)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          data.action === "update_row"
            ? "Add at least one condition — an empty filter would overwrite every row"
            : data.action === "append_heading"
              ? "Add at least one condition — it picks the group the heading is placed under"
              : "Add at least one condition — it picks the group the new row joins",
        path: ["conditions"],
      });
    }
  });

export type GoogleSheetsActionFormValues = z.infer<typeof formSchema>;

type ColorRuleValue = z.infer<typeof colorRuleFormSchema>;

/**
 * Defaults offered as each new rule's color, cycled so consecutive rules never
 * start out identical. Tailwind's green/red/amber/blue/violet 500s — readable as
 * a sheet background, and familiar as status colors.
 */
const DEFAULT_RULE_COLORS = [
  "#22c55e",
  "#ef4444",
  "#f59e0b",
  "#3b82f6",
  "#a855f7",
];

/** A pickable field the node exposes for its appended-row columns. */
type DiscoveredField = { path: string; label: string };

/**
 * What the dialog emits: the form values plus the derived `discoveredFields`
 * (one per header, pointing at `rowByHeader.<sanitizedHeader>`) so downstream
 * nodes can pick appended columns from the variable picker.
 */
export type GoogleSheetsActionSubmitValues = GoogleSheetsActionFormValues & {
  discoveredFields?: DiscoveredField[];
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GoogleSheetsActionSubmitValues) => void;
  defaultValues?: Partial<GoogleSheetsActionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

/**
 * Shared loading / error / no-headers notice for every action's column UI.
 * Returns null once headers are available, so the caller renders its own
 * "ready" content (the mapping or filter summary).
 */
function ColumnsNotice({
  isLoading,
  isError,
  hasSpreadsheet,
  headerCount,
}: {
  isLoading: boolean;
  isError: boolean;
  hasSpreadsheet: boolean;
  headerCount: number;
}) {
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading columns…</p>;
  if (isError)
    return (
      <p className="text-sm text-destructive">
        Couldn't read columns. Check the tab name and that your Google account
        is connected.
      </p>
    );
  if (headerCount === 0 && hasSpreadsheet)
    return (
      <p className="text-sm text-muted-foreground">
        No header row found in row 1 of this tab.
      </p>
    );
  if (headerCount === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Pick a spreadsheet and tab to load its columns.
      </p>
    );
  return null;
}

/**
 * The "match the columns" overlay, shared by every action that writes columns.
 * append_row (any position) CREATES a row, so it also gets the "may be blank"
 * toggle and the Serial Number hint (pass `requiredColumns` + `onRequiredChange`);
 * update_row overwrites an existing row, where neither applies — an unmapped
 * column there simply keeps its value.
 */
function ColumnMappingPanel({
  open,
  onOpenChange,
  title,
  description,
  headers,
  value,
  onChange,
  currentNodeId,
  workflowId,
  requiredColumns,
  onRequiredChange,
  extraGroups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  headers: string[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  currentNodeId: string;
  workflowId?: string;
  requiredColumns?: string[];
  onRequiredChange?: (header: string, required: boolean) => void;
  /** Fields this node offers itself (the insert action's anchor row). */
  extraGroups?: PickerExtraGroup[];
}) {
  const creatingRow = Boolean(requiredColumns && onRequiredChange);
  return (
    <WideOverlayPanel
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
    >
      <FieldMapping
        targets={headers.map((h) => ({ key: h, label: h }))}
        value={value}
        onChange={onChange}
        currentNodeId={currentNodeId}
        workflowId={workflowId}
        extraGroups={extraGroups}
        anchorClassName="ml-96"
        renderAccessory={
          creatingRow
            ? (target) => (
                <span className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                  <Switch
                    aria-label={`${target.label} may be blank`}
                    checked={!requiredColumns?.includes(target.key)}
                    onCheckedChange={(mayBeBlank) =>
                      onRequiredChange?.(target.key, !mayBeBlank)
                    }
                  />
                  May be blank
                </span>
              )
            : undefined
        }
      />
      {creatingRow ? (
        <p className="mt-4 text-xs text-muted-foreground">
          To auto-number a column, map it to the “Serial Number” field (the
          picker’s “Custom” group).
        </p>
      ) : null}
      <div className="mt-6 flex justify-end">
        <Button type="button" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </div>
    </WideOverlayPanel>
  );
}

/**
 * The heading search box, shared by all three actions that select a heading —
 * find, update and colour. A search BOX rather than the conditions editor: a
 * heading's text always sits in the tab's first column, so the column is implied
 * and only "how to compare" and "compare to what" are left to choose.
 *
 * The restraints below are the same shared control every comparing node uses, so
 * a heading search can be relaxed exactly like a row condition — neglecting the
 * "—" in "Invoices — March 2026", say. `ignoreCase` is resolved through the one
 * shared default (ON), so the toggle states what the executor will actually do.
 */
function HeadingFilterInput({
  value,
  onChange,
  currentNodeId,
  workflowId,
  label,
  emptyHint,
}: {
  value: HeadingFilter | undefined;
  onChange: (next: HeadingFilter) => void;
  currentNodeId: string;
  workflowId?: string;
  label: string;
  /** What happens when the box is left empty — it differs per action. */
  emptyHint: string;
}) {
  const operator = value?.operator ?? "equals";
  const options = resolveHeadingFilterOptions(value);
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-start gap-2">
        <Select
          value={operator}
          onValueChange={(next) =>
            onChange({ ...value, operator: next as HeadingMatchOperator })
          }
        >
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HEADING_MATCH_OPERATORS.map((op) => (
              <SelectItem key={op} value={op}>
                {HEADING_MATCH_OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <VariableInput
          placeholder="Invoices — March 2026"
          value={value?.value ?? ""}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
          currentNodeId={currentNodeId}
          workflowId={workflowId}
          anchorClassName="ml-96"
        />
      </div>

      {/* Only one heading action renders at a time, so a single id prefix is
          enough to keep these controls' labels unambiguous. */}
      <MatchingOptions
        operator={operator}
        ignoreCase={options.ignoreCase}
        ignoreChars={options.ignoreChars}
        numeric={options.numeric}
        onChange={(patch) => onChange({ ...value, ...patch })}
        idPrefix="heading-filter"
      />

      <p className="text-xs text-muted-foreground">{emptyHint}</p>
    </div>
  );
}

/**
 * "When several headings match, which ones?" — shared by find_heading and
 * color_heading, which ask exactly the same question of exactly the same set.
 *
 * `each` is the only mode that fans out, so the fan-out cap appears only for it
 * — a "max" input beside a mode that runs once would be meaningless.
 */
function HeadingMatchModeSelect({
  value,
  onChange,
  maxItems,
  onMaxItemsChange,
  verb,
}: {
  value: HeadingMatchMode | undefined;
  onChange: (next: HeadingMatchMode) => void;
  maxItems: number | undefined;
  onMaxItemsChange: (next: number | undefined) => void;
  /** What the action does to a heading, e.g. "returned", "colored". */
  verb: string;
}) {
  const mode = value ?? "all";
  return (
    <div className="space-y-2">
      <Label>When several headings match</Label>
      <Select
        value={mode}
        onValueChange={(v) => onChange(v as HeadingMatchMode)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HEADING_MATCH_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {HEADING_MATCH_MODE_LABELS[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {mode === "first"
          ? `Only the topmost matching heading is ${verb}; the rest are left alone.`
          : mode === "last"
            ? `Only the bottom-most matching heading is ${verb}; the rest are left alone.`
            : mode === "each"
              ? `Every matching heading is ${verb}, and the steps after this one run once per heading.`
              : `Every matching heading is ${verb}. The steps after this one still run once.`}
      </p>
      {mode === "each" ? (
        <FanOutCapInput
          itemNoun="heading"
          maxItems={maxItems}
          onMaxItemsChange={onMaxItemsChange}
        />
      ) : null}
    </div>
  );
}

/**
 * "Which rows may this filter touch?" — shared by every action that selects rows
 * with the conditions editor. A heading is structurally an ordinary row, so
 * without this a filter matching its text would overwrite or repaint a section
 * title; this is also the only way to deliberately target one.
 */
function RowScopeSelect({
  value,
  onChange,
  itemNoun,
}: {
  value: RowScope | undefined;
  onChange: (next: RowScope) => void;
  /** What the action does to the rows it selects, e.g. "changed", "colored". */
  itemNoun: string;
}) {
  const scope = value ?? "data";
  return (
    <div className="space-y-2">
      <Label>Which rows can be {itemNoun}</Label>
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
        {scope === "headings"
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

/**
 * Presets offered by the heading's two color pickers. Text gets neutrals (a
 * heading is read, not decorated); background gets tints light enough to keep
 * black text legible — the palette a section header actually wants, rather than
 * the saturated status colors `color_rows` uses to flag rows.
 */
const HEADING_TEXT_COLORS = ["#000000", "#374151", "#1e3a8a", "#7f1d1d"];
const HEADING_BACKGROUND_COLORS = [
  "#ffffff",
  "#f3f4f6",
  "#fef3c7",
  "#dbeafe",
  "#dcfce7",
];

/**
 * The heading row's style controls: weight, slant, size, and the two colors,
 * plus how the text sits inside its merged band.
 *
 * Controlled like the other editors here — the parent owns the value — and it
 * always hands back a COMPLETE format (defaults resolved from the one shared
 * `resolveHeadingFormat`), so what the dialog shows and what the executor writes
 * can't disagree about an unset field.
 */
function HeadingStyleEditor({
  value,
  onChange,
}: {
  value: HeadingFormat | undefined;
  onChange: (next: HeadingFormat) => void;
}) {
  const f = resolveHeadingFormat(value);
  const update = (patch: Partial<HeadingFormat>) =>
    onChange({ ...f, ...patch });

  return (
    <div className="space-y-4">
      {/* The band as it will land in the sheet — same weight, slant, size,
          colors and alignment, so the choices below are read rather than
          imagined. */}
      <div className="space-y-2">
        <Label className="text-xs">Preview</Label>
        <div
          className="rounded-md border px-3 py-2"
          style={{
            backgroundColor: f.backgroundColor,
            color: f.textColor,
            fontWeight: f.bold ? 700 : 400,
            fontStyle: f.italic ? "italic" : "normal",
            fontSize: `${f.fontSize}px`,
            textAlign:
              f.align === "CENTER"
                ? "center"
                : f.align === "RIGHT"
                  ? "right"
                  : "left",
          }}
        >
          Heading
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <span className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Bold"
            checked={f.bold}
            onCheckedChange={(bold) => update({ bold })}
          />
          Bold
        </span>
        <span className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Italic"
            checked={f.italic}
            onCheckedChange={(italic) => update({ italic })}
          />
          Italic
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs" htmlFor="heading-font-size">
            Font size
          </Label>
          <Input
            id="heading-font-size"
            type="number"
            min={HEADING_FONT_SIZE.min}
            max={HEADING_FONT_SIZE.max}
            value={f.fontSize}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              // A half-typed field must not write NaN into the form (zod would
              // reject the save with an error the user can't see from here) —
              // fall back to the default until a real number is typed.
              update({
                fontSize: Number.isFinite(n)
                  ? n
                  : DEFAULT_HEADING_FORMAT.fontSize,
              });
            }}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Alignment</Label>
          <Select
            value={f.align}
            onValueChange={(align) =>
              update({ align: align as HeadingFormat["align"] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LEFT">Left</SelectItem>
              <SelectItem value="CENTER">Center</SelectItem>
              <SelectItem value="RIGHT">Right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <span className="flex items-center gap-2 text-sm">
          <ColorPicker
            value={f.textColor}
            onChange={(textColor) => update({ textColor })}
            label="Heading text color"
            presets={HEADING_TEXT_COLORS}
          />
          Text color
        </span>
        <span className="flex items-center gap-2 text-sm">
          <ColorPicker
            value={f.backgroundColor}
            onChange={(backgroundColor) => update({ backgroundColor })}
            label="Heading background color"
            presets={HEADING_BACKGROUND_COLORS}
          />
          Background
        </span>
      </div>
    </div>
  );
}

/**
 * The shape react-hook-form gives `errors.colorRules`: an array-like with a
 * per-index entry for each failing rule (plus an optional array-level
 * `message`). Typed narrowly here because RHF's own FieldErrors generic doesn't
 * index cleanly through an array of objects.
 */
type ColorRuleErrors = {
  [index: number]:
    | { color?: { message?: string }; conditions?: { message?: string } }
    | undefined;
};

/** A fresh color rule, with a stable UI id for React keys. */
const newColorRule = (): ColorRuleValue => ({
  id: createId(),
  color: DEFAULT_RULE_COLORS[0],
  conditions: [newRowCondition()],
});

/**
 * The color_rules editor: N ordered rule cards, each a color + its own row
 * filter. Rules are applied top-to-bottom and the FIRST match wins, so order is
 * meaningful and the cards are numbered.
 *
 * Controlled like `FieldMapping` / `RowMatchConditions` — the parent owns the
 * array — and it composes `RowMatchConditions` per rule rather than restating
 * any of the condition UI.
 */
function ColorRulesEditor({
  value,
  onChange,
  currentNodeId,
  workflowId,
  columnOptions,
  errors,
}: {
  value: ColorRuleValue[];
  onChange: (next: ColorRuleValue[]) => void;
  currentNodeId: string;
  workflowId?: string;
  columnOptions?: string[];
  /**
   * Per-rule validation messages, indexed alongside `value`. Zod reports a bad
   * color / empty filter at `["colorRules", i, ...]`, which never lands on the
   * array-level `errors.colorRules.message` the collapsed summary reads — so
   * without rendering them HERE a rejected save shows the user nothing at all.
   */
  errors?: ColorRuleErrors;
}) {
  const update = (index: number, patch: Partial<ColorRuleValue>) =>
    onChange(value.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No rules yet — add one to choose which rows get colored.
        </p>
      ) : null}

      {value.map((rule, index) => {
        const ruleError = errors?.[index];
        return (
          <div key={rule.id} className="space-y-3 rounded-md border p-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                Rule {index + 1}
              </span>
              {/* Themed swatch + board popover. Commits on release, not per
                  drag value, so the host dialog doesn't re-render mid-pick. The
                  rule palette doubles as one-click presets. */}
              <ColorPicker
                value={rule.color}
                onChange={(color) => update(index, { color })}
                label={`Rule ${index + 1} color`}
                presets={DEFAULT_RULE_COLORS}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto text-muted-foreground"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            {ruleError?.color?.message ? (
              <p className="text-sm text-destructive">
                {ruleError.color.message} — use a hex value like #22c55e.
              </p>
            ) : null}

            <div className="space-y-2">
              <Label className="text-xs">Color a row when…</Label>
              <RowMatchConditions
                value={rule.conditions}
                onChange={(next) => update(index, { conditions: next })}
                currentNodeId={currentNodeId}
                workflowId={workflowId}
                columnOptions={columnOptions}
                anchorClassName="ml-96"
              />
              {ruleError?.conditions?.message ? (
                <p className="text-sm text-destructive">
                  {ruleError.conditions.message}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([
            ...value,
            {
              ...newColorRule(),
              // Cycle the palette so a second rule doesn't default to the same
              // color as the first.
              color:
                DEFAULT_RULE_COLORS[value.length % DEFAULT_RULE_COLORS.length],
            },
          ])
        }
      >
        <Plus className="size-4" />
        Add rule
      </Button>
    </div>
  );
}

export const GoogleSheetsActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const trpc = useTRPC();
  // Read the node imperatively at submit time (for its ref) instead of
  // subscribing via useNodes(), which would re-render the dialog on every
  // canvas/status change while it is open.
  const { getNode } = useReactFlow();
  const [mappingOpen, setMappingOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const { data: sheets = [], isLoading } = useQuery(
    trpc.credentials.getGoogleSheets.queryOptions(),
  );

  const buildDefaults = (): GoogleSheetsActionFormValues => {
    // Saved data may still carry the retired `read_rows` / `insert_row_adjacent`
    // actions (and the latter's `insertUnder`). Coerce them the same way the
    // config schema does so an old node re-opens as its modern equivalent:
    //   read_rows            → find_rows
    //   insert_row_adjacent  → append_row + position (from insertUnder)
    const legacy = defaultValues as unknown as {
      action?: string;
      insertUnder?: "group" | "each_row";
      position?: GoogleSheetsActionFormValues["position"];
    };
    const action: GoogleSheetsActionFormValues["action"] =
      legacy.action === "read_rows"
        ? "find_rows"
        : legacy.action === "insert_row_adjacent"
          ? "append_row"
          : ((legacy.action as GoogleSheetsActionFormValues["action"]) ??
            "append_row");
    const position: GoogleSheetsActionFormValues["position"] =
      legacy.position ??
      (legacy.action === "insert_row_adjacent"
        ? legacy.insertUnder === "each_row"
          ? "under_each"
          : "under_group"
        : "bottom");
    return {
      action,
      position,
      spreadsheetId: defaultValues.spreadsheetId ?? "",
      sheetName: defaultValues.sheetName ?? "Sheet1",
      columnMappings: defaultValues.columnMappings ?? {},
      requiredColumns: defaultValues.requiredColumns ?? [],
      blankRowAbove: defaultValues.blankRowAbove ?? false,
      headingText: defaultValues.headingText ?? "",
      // Resolved rather than passed through, so every control below is
      // controlled from the first render (an undefined field would otherwise make
      // its input flip from uncontrolled to controlled on first edit).
      headingFormat: resolveHeadingFormat(defaultValues.headingFormat),
      // Restraints resolved rather than passed through, for the same reason
      // `headingFormat` is: an unset `ignoreCase` would leave its Switch
      // uncontrolled AND would show "off" for a search the executor runs
      // case-insensitively.
      headingFilter: {
        operator: defaultValues.headingFilter?.operator ?? "equals",
        value: defaultValues.headingFilter?.value,
        ...resolveHeadingFilterOptions(defaultValues.headingFilter),
      },
      rowScope: defaultValues.rowScope ?? "data",
      restyleHeading: defaultValues.restyleHeading ?? false,
      headingColor: defaultValues.headingColor ?? HEADING_BACKGROUND_COLORS[1],
      // find keeps "all" (list every match, run once), color keeps "all" (paint
      // every match) — each action's original behaviour.
      onMultipleHeadings: defaultValues.onMultipleHeadings ?? "all",
      // Backfill a stable UI id on saved conditions (older saves lacked one).
      conditions: (defaultValues.conditions ?? []).map((c) => ({
        ...c,
        id: c.id ?? createId(),
      })),
      // Backfill stable UI ids on saved rules and their conditions, as the
      // shared `conditions` list above does.
      colorRules: (defaultValues.colorRules ?? []).map((r) => ({
        ...r,
        id: r.id ?? createId(),
        conditions: (r.conditions ?? []).map((c) => ({
          ...c,
          id: c.id ?? createId(),
        })),
      })),
      onMultipleMatches: defaultValues.onMultipleMatches ?? "first",
      // Default "all" preserves the pre-feature behavior (paint every match), so
      // existing color_rows nodes keep working with no migration.
      onMultipleColorMatches: defaultValues.onMultipleColorMatches ?? "all",
      // Left undefined when unset — the control shows the default as a
      // placeholder and the executor applies DEFAULT_MAX_FAN_OUT_ITEMS.
      maxFanOutItems: defaultValues.maxFanOutItems,
    };
  };

  const form = useForm<GoogleSheetsActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: buildDefaults(),
  });

  const action = form.watch("action");
  const spreadsheetId = form.watch("spreadsheetId");
  const sheetName = form.watch("sheetName");
  const columnMappings = form.watch("columnMappings") ?? {};
  const requiredColumns = form.watch("requiredColumns") ?? [];
  const conditions = form.watch("conditions") ?? [];
  const position = form.watch("position") ?? "bottom";
  const colorRules = form.watch("colorRules") ?? [];
  const colorMatchMode = form.watch("onMultipleColorMatches") ?? "all";
  const headingFormat = form.watch("headingFormat");
  // Defaults filled once, for the collapsed style summary below.
  const resolvedHeading = resolveHeadingFormat(headingFormat);
  // The two row-ADDING actions share this whole block: same position control,
  // same filter, same blank-separator toggle. Only the row's CONTENT differs.
  const isAppending = action === "append_row" || action === "append_heading";
  const isHeading = action === "append_heading";
  // Present for BOTH an array-level issue (no rules at all) and a per-rule one
  // (bad color / empty filter) — the latter carries no `.message` of its own,
  // which is why the summary below can't just read `.message`.
  const colorRulesError = form.formState.errors.colorRules;

  // biome-ignore lint/correctness/useExhaustiveDependencies: buildDefaults reads props/defaultValues, re-run only on open/defaults change.
  useEffect(() => {
    if (!open) return;
    form.reset(buildDefaults());
    // The nested overlays are separate Dialogs whose open state would otherwise
    // outlive this dialog — reopening the node would pop one straight back up.
    setMappingOpen(false);
    setFilterOpen(false);
  }, [open, defaultValues, form]);

  // Live header row of the chosen spreadsheet/tab → mapping targets / filter columns.
  const columnsQuery = useQuery({
    ...trpc.credentials.getSheetColumns.queryOptions({
      spreadsheetId,
      sheetName,
    }),
    enabled: Boolean(spreadsheetId) && Boolean(sheetName),
  });
  const headers = columnsQuery.data?.headers ?? [];

  // Count only columns that still exist in the live header row. Stale mappings
  // for columns the sheet no longer has must not inflate the count (else a sheet
  // trimmed from 13 to 4 columns reads "13 of 4 mapped").
  const mappedCount = headers.filter((h) => {
    const v = columnMappings[h];
    return typeof v === "string" && v.trim();
  }).length;

  // insert_row_adjacent offers the row a new row is placed under as its OWN
  // picker group, so a column can be filled from the row above it. It is not an
  // upstream node's output, so it can't come from getUpstreamFields — hence the
  // picker's `extraGroups` seam.
  const anchorGroups: PickerExtraGroup[] =
    headers.length > 0
      ? [
          {
            label: "The row it is placed under",
            fields: headers.map((h) => ({
              fieldLabel: `${h} (row above)`,
              insertText: `@<${anchorRowPath(h)}>@`,
            })),
          },
        ]
      : [];

  // A column is "required" when its "may be blank" toggle is off.
  const setRequired = (header: string, required: boolean) => {
    const current = form.getValues("requiredColumns") ?? [];
    const next = required
      ? current.includes(header)
        ? current
        : [...current, header]
      : current.filter((h) => h !== header);
    form.setValue("requiredColumns", next);
  };

  const handleSubmit = (values: GoogleSheetsActionFormValues) => {
    // Derive the pickable row outputs from the live header row. Paths are
    // prefixed with this node's output key (its ref, or the legacy fallback)
    // so downstream `@<REF.rowByHeader.Header>@` references resolve.
    const node = getNode(currentNodeId);
    const outputKey = getOutputKeyForNode(
      NodeType.GOOGLE_SHEETS_ACTION,
      currentNodeId,
      (node as { ref?: string | null } | undefined)?.ref,
    );

    // Only emit the keys THIS action actually uses. The form keeps every field
    // populated so each control stays controlled from first render, but writing
    // all of them back would stamp a full heading style block onto every
    // find_rows / update_row / color_rows node that was merely opened and saved.
    //
    // Omitting a key does NOT erase it: the canvas merges the payload over the
    // node's existing data, so a node switched away from a heading action and
    // back keeps the style it was given.
    const payload: GoogleSheetsActionSubmitValues = { ...values };
    // DELETE, never `= undefined` — the canvas merges this over the node's saved
    // data, and a present-but-undefined key would overwrite the saved value
    // rather than leave it alone.
    // `headingText` + `headingFormat` belong to the two actions that WRITE a
    // heading; `headingFilter` to the three that SELECT one.
    if (
      values.action !== "append_heading" &&
      values.action !== "update_heading"
    ) {
      delete payload.headingText;
      delete payload.headingFormat;
    }
    if (
      values.action !== "find_heading" &&
      values.action !== "update_heading" &&
      values.action !== "color_heading"
    ) {
      delete payload.headingFilter;
    }
    if (values.action !== "update_heading") delete payload.restyleHeading;
    if (values.action !== "color_heading") delete payload.headingColor;
    // Only the two heading SELECTORS read the mode.
    if (values.action !== "find_heading" && values.action !== "color_heading") {
      delete payload.onMultipleHeadings;
    }
    // `rowScope` only means something where a CONDITIONS filter picks rows and
    // the action could legitimately touch either kind. The heading actions fix
    // their own scope, and saving "data" ("skip heading rows") onto one of them
    // would state the exact opposite of what it does.
    if (
      values.action === "find_rows" ||
      values.action === "find_heading" ||
      values.action === "update_heading" ||
      values.action === "color_heading" ||
      (values.action === "append_row" &&
        (values.position ?? "bottom") === "bottom")
    ) {
      delete payload.rowScope;
    }

    if (values.action === "find_rows") {
      // Every column exposes two pickable fields: the value from the matched
      // row (the first or last match, per "When multiple rows match" — or, in
      // "each" mode, the current child run's row), and the unique-values list
      // (for downstream in_list).
      if (headers.length > 0) {
        payload.discoveredFields = headers.flatMap((h) => {
          const key = sanitizeHeaderKey(h);
          return [
            {
              path: `${outputKey}.firstRow.${key}`,
              label: `${h} (matched row)`,
            },
            {
              path: `${outputKey}.columnValues.${key}`,
              label: `${h} (all values)`,
            },
          ];
        });
      }
    } else if (
      values.action === "color_rows" ||
      values.action === "append_heading" ||
      values.action === "find_heading" ||
      values.action === "update_heading" ||
      values.action === "color_heading"
    ) {
      // Neither writes columns, so neither exposes per-column paths — a heading
      // is one merged cell, and its text is already a declared output field
      // (`headingText` in node-outputs.ts). Leave `discoveredFields` untouched
      // rather than emitting an empty list, so a node switched to one of these
      // actions and back keeps its saved fields.
    } else if (headers.length > 0) {
      // append_row + update_row both emit `rowByHeader` — the row this run
      // wrote. Same paths, so a node switched between them keeps its
      // references working.
      payload.discoveredFields = headers.map((h) => ({
        path: `${outputKey}.rowByHeader.${sanitizeHeaderKey(h)}`,
        label: h,
      }));
    }
    // else: columns not yet loaded — omit so the node preserves any previously
    // saved discoveredFields.

    onSubmit(payload);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Add, find or update rows in a connected spreadsheet.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="action"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select action" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="append_row">Append row</SelectItem>
                      <SelectItem value="append_heading">
                        Append row — heading
                      </SelectItem>
                      <SelectItem value="find_rows">Find rows</SelectItem>
                      <SelectItem value="find_heading">
                        Find rows — heading
                      </SelectItem>
                      <SelectItem value="update_row">Update row</SelectItem>
                      <SelectItem value="update_heading">
                        Update row — heading
                      </SelectItem>
                      <SelectItem value="color_rows">Color rows</SelectItem>
                      <SelectItem value="color_heading">
                        Color rows — heading
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {action === "find_rows" ? (
                    <FormDescription>
                      This step has two outputs — <strong>Found</strong> and{" "}
                      <strong>Not found</strong>. Connect each to the branch
                      that should run when a matching row does or doesn&apos;t
                      exist.
                    </FormDescription>
                  ) : action === "update_row" ? (
                    <FormDescription>
                      This step has two outputs — <strong>Updated</strong> and{" "}
                      <strong>No match</strong>. Connect each to the branch that
                      should run when a row is or isn&apos;t updated.
                    </FormDescription>
                  ) : action === "color_rows" ? (
                    <FormDescription>
                      This step has two outputs — <strong>Colored</strong> and{" "}
                      <strong>No match</strong>. Connect each to the branch that
                      should run when a row is or isn&apos;t colored.
                    </FormDescription>
                  ) : action === "append_heading" ? (
                    <FormDescription>
                      Adds a row holding a single piece of text, with its cells
                      merged into one band across the tab&apos;s columns — a
                      section title above the rows that follow it.
                    </FormDescription>
                  ) : action === "find_heading" ? (
                    <FormDescription>
                      Searches the tab&apos;s <strong>heading rows only</strong>
                      &nbsp;— ordinary data rows are never returned. Two
                      outputs, <strong>Found</strong> and{" "}
                      <strong>Not found</strong>.
                    </FormDescription>
                  ) : action === "update_heading" ? (
                    <FormDescription>
                      Renames a section title, and optionally restyles it. Only
                      heading rows are touched — never your data. Two outputs,{" "}
                      <strong>Updated</strong> and <strong>No match</strong>.
                    </FormDescription>
                  ) : action === "color_heading" ? (
                    <FormDescription>
                      Paints matching section titles one color. Only heading
                      rows are touched — never your data. Two outputs,{" "}
                      <strong>Colored</strong> and <strong>No match</strong>.
                    </FormDescription>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="spreadsheetId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Spreadsheet</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isLoading}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            isLoading
                              ? "Loading spreadsheets..."
                              : "Select a spreadsheet"
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {sheets.map((sheet) => (
                        <SelectItem key={sheet.id} value={sheet.id}>
                          {sheet.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="sheetName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tab name</FormLabel>
                  <FormControl>
                    <Input placeholder="Sheet1" {...field} />
                  </FormControl>
                  <FormDescription>
                    The tab inside your spreadsheet (shown at the bottom of
                    Google Sheets).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isAppending ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Position</Label>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      {position === "under_each"
                        ? "Under every matching row"
                        : position === "under_group"
                          ? "Under a matching group"
                          : "Bottom of the tab"}
                      {position !== "bottom"
                        ? ` · ${conditions.length} condition${
                            conditions.length === 1 ? "" : "s"
                          }`
                        : ""}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFilterOpen(true)}
                    >
                      Configure position
                    </Button>
                  </div>
                  {form.formState.errors.conditions?.message ? (
                    <p className="text-sm text-destructive">
                      {String(form.formState.errors.conditions.message)}
                    </p>
                  ) : null}

                  <WideOverlayPanel
                    open={filterOpen}
                    onOpenChange={setFilterOpen}
                    title={
                      isHeading
                        ? "Where the heading goes"
                        : "Where the row goes"
                    }
                    description={
                      isHeading
                        ? "Add the heading at the bottom of the tab, or place it under the rows that match a filter."
                        : "Add the row at the bottom of the tab, or place it under the rows that match a filter."
                    }
                  >
                    <div className="space-y-6">
                      <FormField
                        control={form.control}
                        name="position"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {isHeading
                                ? "Where the heading goes"
                                : "Where the row goes"}
                            </FormLabel>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value ?? "bottom"}
                            >
                              <FormControl>
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="bottom">
                                  Bottom of the tab
                                </SelectItem>
                                <SelectItem value="under_group">
                                  Under a particular group of rows or row
                                </SelectItem>
                                <SelectItem value="under_each">
                                  Under multiple particular rows
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <FormDescription>
                              {position === "under_each"
                                ? `One new ${
                                    isHeading ? "heading" : "row"
                                  } under each matching row. The steps after this one then run once per inserted ${
                                    isHeading ? "heading" : "row"
                                  }.`
                                : position === "under_group"
                                  ? isHeading
                                    ? "One heading, directly under the last matching row — so it sits at the bottom of that group."
                                    : "One new row, directly under the last matching row — so it joins the bottom of the group."
                                  : `The new ${
                                      isHeading ? "heading" : "row"
                                    } is added at the bottom of the tab.`}
                            </FormDescription>
                          </FormItem>
                        )}
                      />

                      {position === "bottom" ? (
                        <FormField
                          control={form.control}
                          name="blankRowAbove"
                          render={({ field }) => (
                            <FormItem className="flex items-center justify-between gap-3 rounded-md border p-3">
                              <div className="space-y-0.5">
                                <FormLabel>Leave a blank row above</FormLabel>
                                <FormDescription>
                                  Leaves one row empty just above the new{" "}
                                  {isHeading ? "heading" : "row"}, to separate
                                  it from the entries before it.
                                </FormDescription>
                              </div>
                              <FormControl>
                                <Switch
                                  checked={field.value === true}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      ) : null}

                      {position !== "bottom" ? (
                        <>
                          <div className="space-y-2">
                            <Label>Match rows where…</Label>
                            <ColumnsNotice
                              isLoading={columnsQuery.isLoading}
                              isError={columnsQuery.isError}
                              hasSpreadsheet={Boolean(spreadsheetId)}
                              headerCount={headers.length}
                            />
                            <RowMatchConditions
                              value={conditions}
                              onChange={(next) =>
                                form.setValue("conditions", next)
                              }
                              currentNodeId={currentNodeId}
                              workflowId={workflowId}
                              columnOptions={headers}
                              anchorClassName="ml-96"
                            />
                            <p className="text-xs text-muted-foreground">
                              At least one condition is required — it is what
                              picks the group. If no row matches, the new{" "}
                              {isHeading ? "heading" : "row"} is added at the
                              bottom of the tab instead.
                            </p>
                          </div>

                          <RowScopeSelect
                            value={form.watch("rowScope")}
                            onChange={(next) => form.setValue("rowScope", next)}
                            itemNoun="matched as the group"
                          />

                          {position === "under_each" ? (
                            <FanOutCapInput
                              itemNoun="row"
                              maxItems={form.watch("maxFanOutItems")}
                              onMaxItemsChange={(n) =>
                                form.setValue("maxFanOutItems", n)
                              }
                            />
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    <div className="mt-6 flex justify-end">
                      <Button
                        type="button"
                        onClick={() => setFilterOpen(false)}
                      >
                        Done
                      </Button>
                    </div>
                  </WideOverlayPanel>
                </div>

                {isHeading ? (
                  <div className="space-y-4">
                    <FormField
                      control={form.control}
                      name="headingText"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Heading text</FormLabel>
                          <FormControl>
                            <VariableInput
                              placeholder="Invoices — March 2026"
                              value={field.value ?? ""}
                              onChange={field.onChange}
                              currentNodeId={currentNodeId}
                              workflowId={workflowId}
                              // A non-bottom heading can name the group it sits
                              // under, exactly as a mapped column can.
                              extraGroups={
                                position !== "bottom" ? anchorGroups : undefined
                              }
                              anchorClassName="ml-96"
                            />
                          </FormControl>
                          <FormDescription>
                            The one value the merged row holds. It spans every
                            column in the tab&apos;s header row.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="space-y-2">
                      <Label>Style</Label>
                      <div className="flex items-center justify-between gap-3">
                        {/* The collapsed row says what the heading will LOOK
                            like, in its own colors — the same trick the
                            color_rules summary uses. */}
                        <span
                          className="min-w-0 flex-1 truncate rounded-md border px-3 py-1.5 text-sm"
                          style={{
                            backgroundColor: resolvedHeading.backgroundColor,
                            color: resolvedHeading.textColor,
                            fontWeight: resolvedHeading.bold ? 700 : 400,
                            fontStyle: resolvedHeading.italic
                              ? "italic"
                              : "normal",
                          }}
                        >
                          {resolvedHeading.fontSize}pt ·{" "}
                          {resolvedHeading.align.toLowerCase()}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setMappingOpen(true)}
                        >
                          Configure style
                        </Button>
                      </div>
                    </div>

                    <WideOverlayPanel
                      open={mappingOpen}
                      onOpenChange={setMappingOpen}
                      title="Heading style"
                      description="How the merged heading row is typeset. Everything else about the row — borders, number format — is left as the tab already has it."
                    >
                      <HeadingStyleEditor
                        value={headingFormat}
                        onChange={(next) =>
                          form.setValue("headingFormat", next, {
                            shouldValidate: true,
                          })
                        }
                      />
                      <div className="mt-6 flex justify-end">
                        <Button
                          type="button"
                          onClick={() => setMappingOpen(false)}
                        >
                          Done
                        </Button>
                      </div>
                    </WideOverlayPanel>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>
                      {position === "bottom"
                        ? "Match the columns"
                        : "Columns to fill"}
                    </Label>
                    <ColumnsNotice
                      isLoading={columnsQuery.isLoading}
                      isError={columnsQuery.isError}
                      hasSpreadsheet={Boolean(spreadsheetId)}
                      headerCount={headers.length}
                    />
                    {headers.length > 0 ? (
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-muted-foreground">
                          {mappedCount} of {headers.length} mapped
                          {requiredColumns.length > 0
                            ? ` · ${requiredColumns.length} required`
                            : ""}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setMappingOpen(true)}
                        >
                          Configure columns
                        </Button>
                      </div>
                    ) : null}
                    {form.formState.errors.columnMappings?.message ? (
                      <p className="text-sm text-destructive">
                        {String(form.formState.errors.columnMappings.message)}
                      </p>
                    ) : null}

                    <ColumnMappingPanel
                      open={mappingOpen}
                      onOpenChange={setMappingOpen}
                      title={
                        position === "bottom"
                          ? "Match the columns"
                          : "Columns to fill"
                      }
                      description="Map each column to a value or an upstream field. Turn off “May be blank” to require a column."
                      headers={headers}
                      value={columnMappings}
                      onChange={(next) =>
                        form.setValue("columnMappings", next, {
                          shouldValidate: true,
                        })
                      }
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      requiredColumns={requiredColumns}
                      onRequiredChange={setRequired}
                      extraGroups={
                        position !== "bottom" ? anchorGroups : undefined
                      }
                    />
                  </div>
                )}
              </div>
            ) : action === "find_heading" ? (
              <HeadingFilterInput
                value={form.watch("headingFilter")}
                onChange={(next) => form.setValue("headingFilter", next)}
                currentNodeId={currentNodeId}
                workflowId={workflowId}
                label="Find the heading that…"
                emptyHint="Leave the box empty to return every heading on the tab."
              />
            ) : null}
            {action === "find_heading" ? (
              <HeadingMatchModeSelect
                value={form.watch("onMultipleHeadings")}
                onChange={(m) => form.setValue("onMultipleHeadings", m)}
                maxItems={form.watch("maxFanOutItems")}
                onMaxItemsChange={(n) => form.setValue("maxFanOutItems", n)}
                verb="returned"
              />
            ) : null}
            {action === "update_heading" ? (
              <div className="space-y-6">
                <HeadingFilterInput
                  value={form.watch("headingFilter")}
                  onChange={(next) => form.setValue("headingFilter", next)}
                  currentNodeId={currentNodeId}
                  workflowId={workflowId}
                  label="Update the heading that…"
                  emptyHint="Leave the box empty to update the first heading on the tab."
                />

                <FormField
                  control={form.control}
                  name="headingText"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>New heading text</FormLabel>
                      <FormControl>
                        <VariableInput
                          placeholder="Invoices — April 2026"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          currentNodeId={currentNodeId}
                          workflowId={workflowId}
                          anchorClassName="ml-96"
                        />
                      </FormControl>
                      <FormDescription>
                        Leave this empty to keep the heading&apos;s text and
                        only restyle it.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="restyleHeading"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-3 rounded-md border p-3">
                      <div className="space-y-0.5">
                        <FormLabel>Also restyle it</FormLabel>
                        <FormDescription>
                          Re-apply the style below. Off leaves the heading
                          looking exactly as it does now.
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value === true}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {form.watch("restyleHeading") === true ? (
                  <HeadingStyleEditor
                    value={headingFormat}
                    onChange={(next) =>
                      form.setValue("headingFormat", next, {
                        shouldValidate: true,
                      })
                    }
                  />
                ) : null}
              </div>
            ) : action === "color_heading" ? (
              <div className="space-y-6">
                <HeadingFilterInput
                  value={form.watch("headingFilter")}
                  onChange={(next) => form.setValue("headingFilter", next)}
                  currentNodeId={currentNodeId}
                  workflowId={workflowId}
                  label="Color the heading that…"
                  emptyHint="Leave the box empty to color every heading on the tab."
                />

                <div className="space-y-2">
                  <Label>Color</Label>
                  <div className="flex items-center gap-3">
                    <ColorPicker
                      value={
                        form.watch("headingColor") ??
                        HEADING_BACKGROUND_COLORS[1]
                      }
                      onChange={(next) => form.setValue("headingColor", next)}
                      label="Heading background color"
                      presets={HEADING_BACKGROUND_COLORS}
                    />
                    <span className="text-sm text-muted-foreground">
                      Painted across the heading&apos;s merged band.
                    </span>
                  </div>
                  <div className="pt-2">
                    <HeadingMatchModeSelect
                      value={form.watch("onMultipleHeadings")}
                      onChange={(m) => form.setValue("onMultipleHeadings", m)}
                      maxItems={form.watch("maxFanOutItems")}
                      onMaxItemsChange={(n) =>
                        form.setValue("maxFanOutItems", n)
                      }
                      verb="colored"
                    />
                  </div>
                  {form.formState.errors.headingColor?.message ? (
                    <p className="text-sm text-destructive">
                      {String(form.formState.errors.headingColor.message)}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Every matching heading gets this one color. For different
                    colors per heading, use <strong>Color rows</strong> with its
                    row scope set to headings.
                  </p>
                </div>
              </div>
            ) : action === "find_rows" ? (
              <div className="space-y-2">
                <Label>Filter rows</Label>
                <ColumnsNotice
                  isLoading={columnsQuery.isLoading}
                  isError={columnsQuery.isError}
                  hasSpreadsheet={Boolean(spreadsheetId)}
                  headerCount={headers.length}
                />
                {headers.length > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      {conditions.length} condition
                      {conditions.length === 1 ? "" : "s"} · all{" "}
                      {headers.length} columns returned
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFilterOpen(true)}
                    >
                      Configure filter
                    </Button>
                  </div>
                ) : null}

                <WideOverlayPanel
                  open={filterOpen}
                  onOpenChange={setFilterOpen}
                  title="Filter rows"
                  description="Return every column of the rows matching all enabled conditions. No conditions returns every row."
                >
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label>Match rows where…</Label>
                      <RowMatchConditions
                        value={conditions}
                        onChange={(next) => form.setValue("conditions", next)}
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        columnOptions={headers}
                        anchorClassName="ml-96"
                      />
                    </div>
                    <MultiMatchSelect
                      itemNoun="row"
                      mode={form.watch("onMultipleMatches")}
                      onModeChange={(m) =>
                        form.setValue("onMultipleMatches", m)
                      }
                      maxItems={form.watch("maxFanOutItems")}
                      onMaxItemsChange={(n) =>
                        form.setValue("maxFanOutItems", n)
                      }
                    />
                  </div>
                  <div className="mt-6 flex justify-end">
                    <Button type="button" onClick={() => setFilterOpen(false)}>
                      Done
                    </Button>
                  </div>
                </WideOverlayPanel>
              </div>
            ) : action === "color_rows" ? (
              <div className="space-y-2">
                <Label>Color rules</Label>
                <ColumnsNotice
                  isLoading={columnsQuery.isLoading}
                  isError={columnsQuery.isError}
                  hasSpreadsheet={Boolean(spreadsheetId)}
                  headerCount={headers.length}
                />
                {headers.length > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      {/* The palette in miniature, so the collapsed row says
                          what the rules actually do, not just how many. */}
                      {colorRules.length > 0 ? (
                        <span className="flex items-center gap-1">
                          {colorRules.slice(0, 5).map((r) => (
                            <span
                              key={r.id}
                              className="size-3 rounded-sm border"
                              style={{ backgroundColor: r.color }}
                            />
                          ))}
                        </span>
                      ) : null}
                      {colorRules.length} rule
                      {colorRules.length === 1 ? "" : "s"}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFilterOpen(true)}
                    >
                      Configure rules
                    </Button>
                  </div>
                ) : null}
                {/* The array-level message ("Add at least one color rule") when
                    there is one, otherwise a pointer INTO the overlay — a bad
                    color or an empty filter is reported per-rule, and with the
                    overlay closed the user would otherwise see a save that
                    silently does nothing. */}
                {colorRulesError ? (
                  <p className="text-sm text-destructive">
                    {colorRulesError.message
                      ? String(colorRulesError.message)
                      : "One or more rules is incomplete — open Configure rules to fix it."}
                  </p>
                ) : null}

                {/* Gated on loaded headers like the "Configure rules" row above
                    — a match policy is meaningless before a sheet's columns (and
                    so its rules) exist. */}
                {headers.length > 0 ? (
                  <div className="space-y-2 pt-2">
                    <Label>When multiple rows match</Label>
                    <Select
                      value={colorMatchMode}
                      onValueChange={(v) =>
                        form.setValue(
                          "onMultipleColorMatches",
                          v as "first" | "last" | "all",
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      {/* Labels say "topmost"/"bottom-most", not "first"/"last",
                          so they can't be read as the rules' "first match wins"
                          precedence — this is about row position, not rule order. */}
                      <SelectContent>
                        <SelectItem value="all">
                          Color every matching row
                        </SelectItem>
                        <SelectItem value="first">
                          Color only the topmost matching row
                        </SelectItem>
                        <SelectItem value="last">
                          Color only the bottom-most matching row
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {colorMatchMode === "first"
                        ? "Only the topmost matching row is painted; the rest are left unchanged."
                        : colorMatchMode === "last"
                          ? "Only the bottom-most matching row is painted; the rest are left unchanged."
                          : "Every row a rule matches is painted (rules are checked top to bottom, first match wins)."}
                    </p>
                  </div>
                ) : null}

                <WideOverlayPanel
                  open={filterOpen}
                  onOpenChange={setFilterOpen}
                  title="Color rules"
                  description="Give each color the rows it applies to. Rules are checked top to bottom and the first one that matches wins, so a row is only ever colored once."
                >
                  <ColorRulesEditor
                    value={colorRules}
                    onChange={(next) =>
                      form.setValue("colorRules", next, {
                        shouldValidate: true,
                      })
                    }
                    currentNodeId={currentNodeId}
                    workflowId={workflowId}
                    columnOptions={headers}
                    errors={
                      colorRulesError as unknown as ColorRuleErrors | undefined
                    }
                  />
                  <div className="mt-6">
                    <RowScopeSelect
                      value={form.watch("rowScope")}
                      onChange={(next) => form.setValue("rowScope", next)}
                      itemNoun="colored"
                    />
                  </div>
                  <p className="mt-4 text-xs text-muted-foreground">
                    The row is colored across its columns, up to the last one in
                    the header. Every rule needs at least one condition — a rule
                    with an empty filter would color every row in the tab.
                  </p>
                  <div className="mt-6 flex justify-end">
                    <Button type="button" onClick={() => setFilterOpen(false)}>
                      Done
                    </Button>
                  </div>
                </WideOverlayPanel>
              </div>
            ) : action === "update_row" ? (
              <div className="space-y-2">
                <Label>Filter rows</Label>
                <ColumnsNotice
                  isLoading={columnsQuery.isLoading}
                  isError={columnsQuery.isError}
                  hasSpreadsheet={Boolean(spreadsheetId)}
                  headerCount={headers.length}
                />
                {headers.length > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      {conditions.length} condition
                      {conditions.length === 1 ? "" : "s"} · {mappedCount} of{" "}
                      {headers.length} columns written
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFilterOpen(true)}
                    >
                      Configure filter
                    </Button>
                  </div>
                ) : null}
                {form.formState.errors.conditions?.message ? (
                  <p className="text-sm text-destructive">
                    {String(form.formState.errors.conditions.message)}
                  </p>
                ) : null}
                {form.formState.errors.columnMappings?.message ? (
                  <p className="text-sm text-destructive">
                    {String(form.formState.errors.columnMappings.message)}
                  </p>
                ) : null}

                <WideOverlayPanel
                  open={filterOpen}
                  onOpenChange={setFilterOpen}
                  title="Filter rows"
                  description="Overwrite the columns you map, on every row matching all enabled conditions. Rows that don't match are left alone."
                >
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label>Match rows where…</Label>
                      <RowMatchConditions
                        value={conditions}
                        onChange={(next) => form.setValue("conditions", next)}
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        columnOptions={headers}
                        anchorClassName="ml-96"
                      />
                      <p className="text-xs text-muted-foreground">
                        At least one condition is required — an empty filter
                        would overwrite every row.
                      </p>
                    </div>

                    <RowScopeSelect
                      value={form.watch("rowScope")}
                      onChange={(next) => form.setValue("rowScope", next)}
                      itemNoun="changed"
                    />

                    <div className="space-y-2">
                      <MultiMatchSelect
                        itemNoun="row"
                        mode={form.watch("onMultipleMatches")}
                        onModeChange={(m) =>
                          form.setValue("onMultipleMatches", m)
                        }
                        maxItems={form.watch("maxFanOutItems")}
                        onMaxItemsChange={(n) =>
                          form.setValue("maxFanOutItems", n)
                        }
                      />
                      {form.watch("onMultipleMatches") === "each" ? (
                        <p className="text-xs text-muted-foreground">
                          Every matching row is written, not just the first.
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <Label>Columns to write</Label>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-muted-foreground">
                          {mappedCount} of {headers.length} mapped
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setMappingOpen(true)}
                        >
                          Configure columns
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex justify-end">
                    <Button type="button" onClick={() => setFilterOpen(false)}>
                      Done
                    </Button>
                  </div>

                  {/* Layered ON TOP of the filter overlay, same width. */}
                  <ColumnMappingPanel
                    open={mappingOpen}
                    onOpenChange={setMappingOpen}
                    title="Columns to write"
                    description="A mapped column is overwritten with the value below, on every matching row. Unmapped columns keep whatever they already hold."
                    headers={headers}
                    value={columnMappings}
                    onChange={(next) =>
                      form.setValue("columnMappings", next, {
                        shouldValidate: true,
                      })
                    }
                    currentNodeId={currentNodeId}
                    workflowId={workflowId}
                  />
                </WideOverlayPanel>
              </div>
            ) : null}

            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
