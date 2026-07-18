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

const formSchema = z
  .object({
    action: z.enum(["append_row", "find_rows", "update_row"]),
    // append_row only: where the new row lands.
    position: z.enum(["bottom", "under_group", "under_each"]).optional(),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
    // append_row + bottom only: also write a blank separator row above the new one.
    blankRowAbove: z.boolean().optional(),
    conditions: z.array(rowConditionFormSchema).optional(),
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
      onMultipleMatches: defaultValues.onMultipleMatches ?? "first",
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
                                  Leaves one row empty just above the new row, to
                                  separate it from the entries before it.
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
