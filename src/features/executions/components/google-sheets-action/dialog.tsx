"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createId } from "@paralleldrive/cuid2";
import { useQuery } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { FieldMapping } from "@/components/field-mapping";
import {
  FanOutCapInput,
  MultiMatchSelect,
} from "@/components/multi-match-select";
import { RowMatchConditions } from "@/components/row-match-conditions";
import { Button } from "@/components/ui/button";
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
});

const formSchema = z
  .object({
    action: z.enum([
      "append_row",
      "find_rows",
      "update_row",
      "insert_row_adjacent",
    ]),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
    conditions: z.array(rowConditionFormSchema).optional(),
    // insert_row_adjacent only.
    blankSeparators: z.boolean().optional(),
    insertUnder: z.enum(["group", "each_row"]).optional(),
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

    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;
    if (!hasMappings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          data.action === "update_row"
            ? "Map at least one column to update"
            : data.action === "insert_row_adjacent"
              ? "Map at least one column to fill the new row"
              : "Map at least one column to append a row",
        path: ["columnMappings"],
      });
    }

    // Both write actions need a real filter: with none, every row "matches" —
    // update_row would overwrite the whole sheet, and insert_row_adjacent would
    // have no meaningful group to join. Mirrors the config schema's rule.
    if (
      (data.action === "update_row" || data.action === "insert_row_adjacent") &&
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
 * append_row and insert_row_adjacent CREATE a row, so they also get the "may be
 * blank" toggle and the Serial Number hint (pass `requiredColumns` +
 * `onRequiredChange`); update_row overwrites an existing row, where neither
 * applies — an unmapped column there simply keeps its value.
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

  const buildDefaults = (): GoogleSheetsActionFormValues => ({
    // Legacy read_rows nodes open as find_rows — with no conditions it reads
    // every row of the tab, which is the closest surviving equivalent.
    action:
      (defaultValues.action as string) === "read_rows"
        ? "find_rows"
        : (defaultValues.action ?? "append_row"),
    spreadsheetId: defaultValues.spreadsheetId ?? "",
    sheetName: defaultValues.sheetName ?? "Sheet1",
    columnMappings: defaultValues.columnMappings ?? {},
    requiredColumns: defaultValues.requiredColumns ?? [],
    // Backfill a stable UI id on saved conditions (older saves lacked one).
    conditions: (defaultValues.conditions ?? []).map((c) => ({
      ...c,
      id: c.id ?? createId(),
    })),
    // Off by default: a blank separator row changes the SHAPE of the sheet, so
    // it is opted into, never assumed.
    blankSeparators: defaultValues.blankSeparators ?? false,
    // One row below the whole group — the conservative default: it writes one
    // row, exactly as it did before "each_row" existed.
    insertUnder: defaultValues.insertUnder ?? "group",
    onMultipleMatches: defaultValues.onMultipleMatches ?? "first",
    // Left undefined when unset — the control shows the default as a
    // placeholder and the executor applies DEFAULT_MAX_FAN_OUT_ITEMS.
    maxFanOutItems: defaultValues.maxFanOutItems,
  });

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
  const insertUnder = form.watch("insertUnder") ?? "group";

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

  const mappedCount = Object.values(columnMappings).filter(
    (v) => typeof v === "string" && v.trim(),
  ).length;

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
                      <SelectItem value="insert_row_adjacent">
                        Insert row under matching rows
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
              <div className="space-y-2">
                <Label>Match the columns</Label>
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
                  title="Match the columns"
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
                />
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
            ) : action === "insert_row_adjacent" ? (
              <div className="space-y-2">
                <Label>Find the group</Label>
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
                      {conditions.length === 1 ? "" : "s"} ·{" "}
                      {insertUnder === "each_row"
                        ? "one row per match"
                        : "one row below the group"}{" "}
                      · {mappedCount} of {headers.length} columns filled
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
                  title="Find the group"
                  description="The matching rows are the group. A new row is placed under it — below the group as a whole, or below every matching row."
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
                        At least one condition is required — it is what picks
                        the group. If no row matches, the new row starts a new
                        group at the bottom of the tab.
                      </p>
                    </div>

                    <FormField
                      control={form.control}
                      name="insertUnder"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Where the new row goes</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value ?? "group"}
                          >
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="group">
                                Below the group (one new row)
                              </SelectItem>
                              <SelectItem value="each_row">
                                Below every matching row (one new row each)
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription>
                            {insertUnder === "each_row"
                              ? "One new row under each matching row. The steps after this one then run once per inserted row."
                              : "One new row, directly under the last matching row — so it joins the bottom of the group."}
                          </FormDescription>
                        </FormItem>
                      )}
                    />

                    {insertUnder === "each_row" ? (
                      <FanOutCapInput
                        itemNoun="row"
                        maxItems={form.watch("maxFanOutItems")}
                        onMaxItemsChange={(n) =>
                          form.setValue("maxFanOutItems", n)
                        }
                      />
                    ) : null}

                    <FormField
                      control={form.control}
                      name="blankSeparators"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
                          <div className="space-y-0.5">
                            <FormLabel>Separate new groups</FormLabel>
                            <FormDescription>
                              Leave one blank row above a group that is starting
                              for the first time. Rows joining an existing group
                              are never separated.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value ?? false}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <div className="space-y-2">
                      <Label>Columns to fill</Label>
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
                    title="Columns to fill"
                    description="Map each column of the new row to a value, an upstream field, or a cell of the row it is placed under. Turn off “May be blank” to require a column."
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
                    extraGroups={anchorGroups}
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
