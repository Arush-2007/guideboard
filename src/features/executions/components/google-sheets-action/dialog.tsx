"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createId } from "@paralleldrive/cuid2";
import { useQuery } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { useDanglingRefGuard } from "@/components/dangling-ref-guard";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { FieldMapping } from "@/components/field-mapping";
import {
  FanOutCapInput,
  MultiMatchSelect,
} from "@/components/multi-match-select";
import { RowMatchConditions } from "@/components/row-match-conditions";
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
import { WideOverlayPanel } from "@/components/wide-overlay-panel";
import { NodeType } from "@/generated/prisma";
import { compareOptionsSchemaFields } from "@/lib/compare-options-schema";
import { MAX_FAN_OUT_ITEMS_LIMIT, MULTI_MATCH_MODES } from "@/lib/multi-match";
import { getOutputKeyForNode } from "@/lib/node-ref";
import {
  ROW_MATCH_OPERATORS,
  type RowMatchOperator,
} from "@/lib/row-match-operators";
import { anchorRowPath, sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  CELL_ALIGNMENT_LABELS,
  CELL_ALIGNMENTS,
  CELL_FONT_SIZE,
  CELL_VERTICAL_ALIGNMENT_LABELS,
  CELL_VERTICAL_ALIGNMENTS,
  type CellFormat,
  cellFormatSchema,
  DEFAULT_MERGE_MODE,
  DEFAULT_STYLE_MATCH_MODE,
  MERGE_MODE_LABELS,
  MERGE_MODES,
  type MergeMode,
  resolveColumnBand,
  STYLE_MATCH_MODE_LABELS,
  STYLE_MATCH_MODES,
  type StyleMatchMode,
} from "@/lib/sheet-style";
import { refineGoogleSheetsAction } from "@/lib/sheets-action-refine";
import type { PickerExtraGroup } from "@/lib/upstream-fields";
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

const formSchema = z
  .object({
    action: z.enum(["append_row", "find_rows", "update_row", "style_cells"]),
    // append_row only: where the new row lands.
    position: z.enum(["bottom", "under_group", "under_each"]).optional(),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
    // append_row + bottom only: also leave a blank separator row above.
    blankRowAbove: z.boolean().optional(),
    conditions: z.array(rowConditionFormSchema).optional(),
    // style_cells + append_row. `cellFormat` reuses the ONE shared fragment so
    // this resolver can't strip a style property on submit (the dual-schema
    // gotcha).
    cellFormat: cellFormatSchema.optional(),
    mergeMode: z.enum(MERGE_MODES).optional(),
    // style_cells only: narrow the styled band to these headers.
    styleColumns: z.array(z.string()).optional(),
    // append_row only: whether the inline style block applies.
    styleAppendedRow: z.boolean().optional(),
    // append_row + merge ONLY: the single value a merged row holds. Declared
    // here too so the resolver keeps it on submit (the dual-schema gotcha).
    mergedText: z.string().optional(),
    // style_cells only: style the topmost matched row ("first"), the bottom-most
    // ("last"), or every matched row ("all", the default). Declared here too so
    // the resolver keeps it on submit (a plain z.object() strips undeclared keys
    // — the dual-schema gotcha).
    onMultipleStyleMatches: z.enum(STYLE_MATCH_MODES).optional(),
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
  .superRefine(refineGoogleSheetsAction);

export type GoogleSheetsActionFormValues = z.infer<typeof formSchema>;

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
 * Presets for the two colour pickers. Text gets neutrals (cell text is read, not
 * decorated); background gets tints light enough to keep black text legible,
 * plus the saturated status colours a flagged row wants.
 */
const CELL_TEXT_COLORS = ["#000000", "#374151", "#1e3a8a", "#7f1d1d"];
const CELL_BACKGROUND_COLORS = [
  "#ffffff",
  "#f3f4f6",
  "#fef3c7",
  "#dbeafe",
  "#dcfce7",
  "#fee2e2",
];

/** The sentinel a "leave as is" Select uses — Radix forbids an empty value. */
const UNSET = "__unset__";

/**
 * One tri-state toggle: off / on / leave as is.
 *
 * A plain Switch cannot express this, and that distinction is the whole point of
 * the styling feature: `undefined` means "don't touch this property", while
 * `false` means "actively turn it off". A Switch would collapse those two into
 * one, so every unset property would silently be written as `false` and styling
 * a row would strip formatting someone applied by hand.
 */
function TriStateStyle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value === undefined ? UNSET : value ? "on" : "off"}
        onValueChange={(v) => onChange(v === UNSET ? undefined : v === "on")}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Leave as is</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * One optional colour: a "leave as is" switch plus the picker it reveals.
 *
 * The last picked colour is remembered while the switch is off, so toggling it
 * back on does not lose the choice — turning a property off must not be
 * destructive.
 */
function OptionalColor({
  label,
  value,
  onChange,
  presets,
  fallback,
}: {
  label: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  presets: string[];
  fallback: string;
}) {
  const [remembered, setRemembered] = useState(value ?? fallback);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Switch
          aria-label={`Set ${label}`}
          checked={value !== undefined}
          onCheckedChange={(on) => onChange(on ? remembered : undefined)}
        />
        {value === undefined ? (
          <span className="text-xs text-muted-foreground">Leave as is</span>
        ) : (
          <ColorPicker
            value={value}
            onChange={(next) => {
              setRemembered(next);
              onChange(next);
            }}
            label={label}
            presets={presets}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The cell style controls: weight, slant, decoration, size, the two colours, and
 * how the text sits in its cell.
 *
 * EVERY control has a "leave as is" state, and that is the contract this editor
 * exists to express: what you don't set is not written. `cellFormatRequests`
 * builds its Sheets `fields` mask from exactly the properties present here, so a
 * rule that sets only a background leaves the bold, size and colour those cells
 * already have completely alone.
 *
 * Controlled like the other editors here — the parent owns the value.
 */
function CellStyleEditor({
  value,
  onChange,
}: {
  value: CellFormat | undefined;
  onChange: (next: CellFormat) => void;
}) {
  const f = value ?? {};
  // Dropping the key entirely (rather than setting it to `undefined`) keeps the
  // saved config free of null holes, and matches what `hasAnyCellFormat` tests.
  const update = (patch: Partial<CellFormat>) => {
    const next = { ...f, ...patch };
    for (const key of Object.keys(next) as (keyof CellFormat)[]) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(next);
  };

  return (
    <div className="space-y-4">
      {/* The cell as it will land in the sheet. Unset properties render with the
          sheet's own defaults, so the preview shows what WILL change, not a
          promise about what won't. */}
      <div className="space-y-2">
        <Label className="text-xs">Preview</Label>
        <div
          className="rounded-md border px-3 py-2"
          style={{
            backgroundColor: f.backgroundColor ?? "transparent",
            color: f.textColor,
            fontWeight: f.bold ? 700 : 400,
            fontStyle: f.italic ? "italic" : "normal",
            textDecoration:
              [
                f.underline ? "underline" : "",
                f.strikethrough ? "line-through" : "",
              ]
                .filter(Boolean)
                .join(" ") || "none",
            fontSize: f.fontSize ? `${f.fontSize}px` : undefined,
            textAlign:
              f.align === "CENTER"
                ? "center"
                : f.align === "RIGHT"
                  ? "right"
                  : "left",
          }}
        >
          Sample cell
        </div>
        <p className="text-[11px] text-muted-foreground">
          Anything left as “Leave as is” keeps whatever the cells already have.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TriStateStyle
          label="Bold"
          value={f.bold}
          onChange={(bold) => update({ bold })}
        />
        <TriStateStyle
          label="Italic"
          value={f.italic}
          onChange={(italic) => update({ italic })}
        />
        <TriStateStyle
          label="Underline"
          value={f.underline}
          onChange={(underline) => update({ underline })}
        />
        <TriStateStyle
          label="Strikethrough"
          value={f.strikethrough}
          onChange={(strikethrough) => update({ strikethrough })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="cell-font-size">
            Font size
          </Label>
          <Input
            id="cell-font-size"
            type="number"
            min={CELL_FONT_SIZE.min}
            max={CELL_FONT_SIZE.max}
            placeholder="Leave as is"
            value={f.fontSize ?? ""}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) return update({ fontSize: undefined });
              const n = Number.parseInt(raw, 10);
              // A half-typed field must not write NaN into the form (zod would
              // reject the save with an error the user can't see from here) —
              // leave the property unset until a real number is typed.
              update({ fontSize: Number.isFinite(n) ? n : undefined });
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Horizontal align</Label>
          <Select
            value={f.align ?? UNSET}
            onValueChange={(v) =>
              update({
                align: v === UNSET ? undefined : (v as CellFormat["align"]),
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Leave as is</SelectItem>
              {CELL_ALIGNMENTS.map((a) => (
                <SelectItem key={a} value={a}>
                  {CELL_ALIGNMENT_LABELS[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Vertical align</Label>
          <Select
            value={f.verticalAlign ?? UNSET}
            onValueChange={(v) =>
              update({
                verticalAlign:
                  v === UNSET ? undefined : (v as CellFormat["verticalAlign"]),
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Leave as is</SelectItem>
              {CELL_VERTICAL_ALIGNMENTS.map((a) => (
                <SelectItem key={a} value={a}>
                  {CELL_VERTICAL_ALIGNMENT_LABELS[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <OptionalColor
          label="Text color"
          value={f.textColor}
          onChange={(textColor) => update({ textColor })}
          presets={CELL_TEXT_COLORS}
          fallback="#000000"
        />
        <OptionalColor
          label="Background color"
          value={f.backgroundColor}
          onChange={(backgroundColor) => update({ backgroundColor })}
          presets={CELL_BACKGROUND_COLORS}
          fallback="#fef3c7"
        />
      </div>
    </div>
  );
}

/**
 * "Merge these cells?" — none / merge / unmerge.
 *
 * Merging a band into one cell is what makes a row read as a section title, so
 * this is the control that replaces the old dedicated heading action.
 */
function MergeModeSelect({
  value,
  onChange,
  describe,
}: {
  value: MergeMode | undefined;
  onChange: (next: MergeMode) => void;
  describe?: (mode: MergeMode) => string;
}) {
  const mode = value ?? DEFAULT_MERGE_MODE;
  return (
    <div className="space-y-2">
      <Label>Merging</Label>
      <Select value={mode} onValueChange={(v) => onChange(v as MergeMode)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MERGE_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {MERGE_MODE_LABELS[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {describe
          ? describe(mode)
          : mode === "merge"
            ? "The selected cells become one — this is what makes a row read as a section title."
            : mode === "unmerge"
              ? "A merged band is split back into individual cells."
              : "Existing merges are left exactly as they are."}
      </p>
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
      // Passed through UNRESOLVED, deliberately: an unset property means "leave
      // the cells alone", so filling in defaults here would turn every control
      // into an instruction the user never gave. The editor's controls are
      // written to handle `undefined` as a real state.
      cellFormat: defaultValues.cellFormat ?? {},
      mergeMode: defaultValues.mergeMode ?? DEFAULT_MERGE_MODE,
      styleColumns: defaultValues.styleColumns ?? [],
      styleAppendedRow: defaultValues.styleAppendedRow ?? false,
      mergedText: defaultValues.mergedText ?? "",
      // Backfill a stable UI id on saved conditions (older saves lacked one).
      conditions: (defaultValues.conditions ?? []).map((c) => ({
        ...c,
        id: c.id ?? createId(),
      })),
      onMultipleMatches: defaultValues.onMultipleMatches ?? "first",
      // Default "all" — style every matched row, the natural reading of a filter.
      onMultipleStyleMatches:
        defaultValues.onMultipleStyleMatches ?? DEFAULT_STYLE_MATCH_MODE,
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
  const styleMatchMode =
    form.watch("onMultipleStyleMatches") ?? DEFAULT_STYLE_MATCH_MODE;
  const cellFormat = form.watch("cellFormat");
  const mergeMode = form.watch("mergeMode") ?? DEFAULT_MERGE_MODE;
  const styleColumns = form.watch("styleColumns") ?? [];
  const styleAppendedRow = form.watch("styleAppendedRow") ?? false;
  const isAppending = action === "append_row";
  // An append that MERGES writes one cell, not a mapped row — so the whole
  // column-mapping block is replaced by a single text field. See `mergedText`.
  const mergingAppend =
    isAppending && styleAppendedRow && mergeMode === "merge";

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

  /**
   * Headers that sit BETWEEN the picked style columns without being picked.
   *
   * A Sheets range cannot express a gap, so the band applied is the min..max
   * span — meaning a gapped selection would silently style the columns in
   * between. Derived from the SAME `resolveColumnBand` the executor enforces
   * with, so the warning shown here and the error thrown mid-run can never
   * disagree (they previously matched header names differently). It lives
   * outside the config schema because it depends on the tab's live header
   * ORDER, which the schema has no access to.
   */
  const gappedStyleColumns = resolveColumnBand(headers, styleColumns).gap;

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
  // Memoized because this is handed to every mapped column's picker as a prop,
  // and a fresh array each render would defeat their source-list memos on every
  // keystroke in this dialog — of which there are dozens open at once.
  const anchorGroups: PickerExtraGroup[] = useMemo(
    () =>
      headers.length > 0
        ? [
            {
              // The picker heads the panel with this group's name, so each field
              // is just the column — no "(row above)" suffix repeating it.
              label: "Row above",
              fields: headers.map((h) => {
                const path = anchorRowPath(h);
                return { fieldLabel: h, path, insertText: `@<${path}>@` };
              }),
            },
          ]
        : [],
    [headers],
  );

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
    // all of them back would stamp a style block onto every find_rows /
    // update_row node that was merely opened and saved.
    //
    // Omitting a key does NOT erase it: the canvas merges the payload over the
    // node's existing data, so a node switched away from styling and back keeps
    // the style it was given.
    const payload: GoogleSheetsActionSubmitValues = { ...values };
    // DELETE, never `= undefined` — the canvas merges this over the node's saved
    // data, and a present-but-undefined key would overwrite the saved value
    // rather than leave it alone.
    const styling =
      values.action === "style_cells" ||
      (values.action === "append_row" && values.styleAppendedRow === true);
    if (!styling) {
      delete payload.cellFormat;
      delete payload.mergeMode;
    }
    if (values.action !== "style_cells") {
      delete payload.styleColumns;
      delete payload.onMultipleStyleMatches;
    }
    if (values.action !== "append_row") delete payload.styleAppendedRow;
    // Only a MERGING append carries it; a mapped row uses columnMappings.
    if (
      values.action !== "append_row" ||
      values.styleAppendedRow !== true ||
      values.mergeMode !== "merge"
    ) {
      delete payload.mergedText;
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
    } else if (values.action === "style_cells") {
      // Styling writes no column VALUES, so it exposes no per-column paths — the
      // rows it touched are already a declared output field (`rowIndexes` in
      // node-outputs.ts). Leave `discoveredFields` untouched rather than
      // emitting an empty list, so a node switched to styling and back keeps its
      // saved fields.
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

  // Guards the raw FORM VALUES — `form.handleSubmit(guard.save)` runs the guard
  // first and `handleSubmit` (which builds the payload) only once it passes.
  //
  // ⚠️ That makes one agreement load-bearing: this dialog deletes the keys the
  // chosen action doesn't use from the payload, and `inactiveFieldsForNode`
  // (config/node-references.ts) skips the SAME keys during the check. The guard
  // sees them still present, so if the two lists drift the check will warn about
  // a field this dialog is about to drop. Change them together.
  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

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
            onSubmit={form.handleSubmit(guard.save)}
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
                      <SelectItem value="find_rows">Find rows</SelectItem>
                      <SelectItem value="update_row">Update row</SelectItem>
                      <SelectItem value="style_cells">Style cells</SelectItem>
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
                  ) : action === "style_cells" ? (
                    <FormDescription>
                      Formats the rows your filter selects — colors, bold, size,
                      alignment — and can merge them into one cell to make a
                      section title. Anything you leave as “Leave as is” keeps
                      whatever the cells already have. Two outputs,{" "}
                      <strong>Styled</strong> and <strong>No match</strong>.
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
                    title="Where the row goes"
                    description="Add the row at the bottom of the tab, or place it under the rows that match a filter."
                  >
                    <div className="space-y-6">
                      <FormField
                        control={form.control}
                        name="position"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Where the row goes</FormLabel>
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
                                ? "One new row under each matching row. The steps after this one then run once per inserted row."
                                : position === "under_group"
                                  ? "One new row, directly under the last matching row — so it joins the bottom of the group."
                                  : "The new row is added at the bottom of the tab."}
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
                                  Leaves one row empty just above the new row,
                                  to separate it from the entries before it.
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
                              allowMergedColumn
                            />
                            <p className="text-xs text-muted-foreground">
                              At least one condition is required — it is what
                              picks the group. If no row matches, the new row is
                              added at the bottom of the tab instead.
                            </p>
                          </div>

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

                {/* A merged row is ONE cell. Sheets' MERGE_ALL keeps only the
                    top-left value, so offering a column mapper here would let
                    someone fill 16 columns and silently lose 15 of them — and
                    mapping anything but the first column would leave the merged
                    cell blank. So merging swaps the mapper for one field. */}
                {mergingAppend ? (
                  <FormField
                    control={form.control}
                    name="mergedText"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Row text</FormLabel>
                        <FormControl>
                          <VariableInput
                            placeholder="Invoices — March 2026"
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            currentNodeId={currentNodeId}
                            workflowId={workflowId}
                            // A non-bottom merged row can name the group it sits
                            // under, exactly as a mapped column can.
                            extraGroups={
                              position !== "bottom" ? anchorGroups : undefined
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          The single value this merged row holds. It spans the
                          tab&apos;s columns as one cell, so there are no
                          columns to map.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
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

                {/* Style the row this append writes. Merging the band is what
                    turns it into a section title, so making one stays a single
                    node — this is the direct replacement for the old dedicated
                    heading action. */}
                <FormField
                  control={form.control}
                  name="styleAppendedRow"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-3 rounded-md border p-3">
                      <div className="space-y-0.5">
                        <FormLabel>Style this row</FormLabel>
                        <FormDescription>
                          Format the row this step writes, and optionally merge
                          it into one cell to make a section title.
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

                {styleAppendedRow ? (
                  <div className="space-y-6 rounded-md border p-3">
                    <CellStyleEditor
                      value={cellFormat}
                      onChange={(next) =>
                        form.setValue("cellFormat", next, {
                          shouldValidate: true,
                        })
                      }
                    />
                    <MergeModeSelect
                      value={mergeMode}
                      onChange={(m) => form.setValue("mergeMode", m)}
                      describe={(m) =>
                        m === "merge"
                          ? "The row's cells become one band across the tab — a section title. Its value is written exactly as typed, so a title like “0009” or “March 2026” isn't turned into a number or a date."
                          : m === "unmerge"
                            ? "Splits the row back into individual cells."
                            : "The row keeps whatever merging the sheet gives it."
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {action === "find_rows" ? (
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
                        allowMergedColumn
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
            ) : action === "style_cells" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Style rows where…</Label>
                  <ColumnsNotice
                    isLoading={columnsQuery.isLoading}
                    isError={columnsQuery.isError}
                    hasSpreadsheet={Boolean(spreadsheetId)}
                    headerCount={headers.length}
                  />
                  <RowMatchConditions
                    value={conditions}
                    onChange={(next) => form.setValue("conditions", next)}
                    currentNodeId={currentNodeId}
                    workflowId={workflowId}
                    columnOptions={headers}
                    // Styling is where reaching a section title matters most —
                    // recolouring one, or merging a row to create one.
                    allowMergedColumn
                  />
                  {form.formState.errors.conditions?.message ? (
                    <p className="text-sm text-destructive">
                      {String(form.formState.errors.conditions.message)}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    At least one condition is required — an empty filter would
                    restyle every row on the tab. To style section titles, pick{" "}
                    <strong>Merged row</strong> as a condition&apos;s column;
                    without it they are left alone.
                  </p>
                </div>

                {headers.length > 0 ? (
                  <div className="space-y-2">
                    <Label>When several rows match</Label>
                    <Select
                      value={styleMatchMode}
                      onValueChange={(v) =>
                        form.setValue(
                          "onMultipleStyleMatches",
                          v as StyleMatchMode,
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STYLE_MATCH_MODES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {STYLE_MATCH_MODE_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {styleMatchMode === "all"
                        ? "Every matching row is styled. The steps after this one still run once."
                        : styleMatchMode === "first"
                          ? "Only the topmost matching row is styled; the rest are left alone."
                          : "Only the bottom-most matching row is styled; the rest are left alone."}
                    </p>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label>Which columns</Label>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {styleColumns.length === 0
                        ? "The whole row"
                        : styleColumns.join(", ")}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFilterOpen(true)}
                      disabled={headers.length === 0}
                    >
                      Choose columns
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    With none chosen the style spans the tab&apos;s full width —
                    which is what merging a row into a section title needs.
                  </p>
                </div>

                <WideOverlayPanel
                  open={filterOpen}
                  onOpenChange={setFilterOpen}
                  title="Which columns to style"
                  description="Leave every column unticked to style the whole row. A sheet range can't skip a column, so the ones you pick must sit next to each other."
                >
                  {/* A Sheets range has no way to express a gap, so the executor
                      styles the min..max span of what's picked. Flagging a hole
                      HERE — where the header ORDER is known, which the config
                      schema can't see — beats failing mid-run. */}
                  {gappedStyleColumns.length > 0 ? (
                    <p className="mb-3 text-sm text-destructive">
                      These columns aren&apos;t next to each other — styling
                      them would also cover {gappedStyleColumns.join(", ")}.
                      Either tick those too, or narrow the selection.
                    </p>
                  ) : null}
                  <div className="space-y-2">
                    {headers.map((h) => (
                      // A <div>, not a <label>: Radix's Switch renders a button
                      // rather than an input, so a label cannot associate with
                      // it — the Switch carries its own aria-label instead.
                      <div
                        key={h}
                        className="flex items-center gap-2 rounded-md border p-2 text-sm"
                      >
                        <Switch
                          aria-label={h}
                          checked={styleColumns.includes(h)}
                          onCheckedChange={(on) =>
                            form.setValue(
                              "styleColumns",
                              on
                                ? // Kept in HEADER order, not click order, so the
                                  // min..max span the executor merges across reads
                                  // the same as the list shown here.
                                  headers.filter(
                                    (c) => c === h || styleColumns.includes(c),
                                  )
                                : styleColumns.filter((c) => c !== h),
                              { shouldValidate: true },
                            )
                          }
                        />
                        {h}
                      </div>
                    ))}
                  </div>
                  <div className="mt-6 flex justify-end">
                    <Button type="button" onClick={() => setFilterOpen(false)}>
                      Done
                    </Button>
                  </div>
                </WideOverlayPanel>

                <div className="space-y-2">
                  <Label>Style</Label>
                  <div className="rounded-md border p-3">
                    <CellStyleEditor
                      value={cellFormat}
                      onChange={(next) =>
                        form.setValue("cellFormat", next, {
                          shouldValidate: true,
                        })
                      }
                    />
                  </div>
                  {form.formState.errors.cellFormat?.message ? (
                    <p className="text-sm text-destructive">
                      {String(form.formState.errors.cellFormat.message)}
                    </p>
                  ) : null}
                </div>

                <MergeModeSelect
                  value={mergeMode}
                  onChange={(m) =>
                    form.setValue("mergeMode", m, {
                      shouldValidate: true,
                    })
                  }
                />
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
                        allowMergedColumn
                      />
                      <p className="text-xs text-muted-foreground">
                        At least one condition is required — an empty filter
                        would overwrite every row. Section titles (merged rows)
                        are left alone unless a condition picks{" "}
                        <strong>Merged row</strong>, so an ordinary filter can
                        never overwrite one by accident.
                      </p>
                    </div>

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
        {guard.dialog}
      </DialogContent>
    </Dialog>
  );
};
