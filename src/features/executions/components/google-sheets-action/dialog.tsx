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
    action: z.enum(["append_row", "find_rows", "update_row", "color_rows"]),
    // append_row only: where the new row lands.
    position: z.enum(["bottom", "under_group", "under_each"]).optional(),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
    // append_row + bottom only: also write a blank separator row above the new one.
    blankRowAbove: z.boolean().optional(),
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
    // find_rows needs only a spreadsheet + tab (already required).
    if (data.action === "find_rows") return;

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

    const isUnderAppend =
      data.action === "append_row" && (data.position ?? "bottom") !== "bottom";

    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;

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

    const payload: GoogleSheetsActionSubmitValues = { ...values };
    if (values.action === "find_rows") {
      // Every column exposes two pickable fields: the value from the matched
      // row (the first match — or, in "each" mode, the current child run's
      // row), and the unique-values list (for downstream in_list).
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
    } else if (values.action === "color_rows") {
      // color_rows writes no columns, so it exposes no per-column paths. Leave
      // `discoveredFields` untouched rather than emitting an empty list, so a
      // node switched to this action and back keeps its saved fields.
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
                      <SelectItem value="find_rows">Find rows</SelectItem>
                      <SelectItem value="update_row">Update row</SelectItem>
                      <SelectItem value="color_rows">Color rows</SelectItem>
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

            {action === "append_row" ? (
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
                              anchorClassName="ml-96"
                            />
                            <p className="text-xs text-muted-foreground">
                              At least one condition is required — it is what
                              picks the group. If no row matches, the new row
                              starts a new group at the bottom of the tab.
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
