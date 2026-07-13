"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createId } from "@paralleldrive/cuid2";
import { useQuery } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { FieldMapping } from "@/components/field-mapping";
import { MultiMatchSelect } from "@/components/multi-match-select";
import { RowMatchConditions } from "@/components/row-match-conditions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { WideOverlayPanel } from "@/components/wide-overlay-panel";
import { NodeType } from "@/generated/prisma";
import { MAX_FAN_OUT_ITEMS_LIMIT, MULTI_MATCH_MODES } from "@/lib/multi-match";
import { getOutputKeyForNode } from "@/lib/node-ref";
import {
  ROW_MATCH_OPERATORS,
  type RowMatchOperator,
} from "@/lib/row-match-operators";
import { sanitizeHeaderKey } from "@/lib/sheet-headers";
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
    action: z.enum(["append_row", "find_rows"]),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
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
    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;
    if (!hasMappings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Map at least one column to append a row",
        path: ["columnMappings"],
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
 * Shared loading / error / no-headers notice for the append + find_rows column
 * UIs. Returns null once headers are available, so the caller renders its own
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: buildDefaults reads props/defaultValues, re-run only on open/defaults change.
  useEffect(() => {
    if (open) form.reset(buildDefaults());
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
          <DialogTitle>Google Sheets</DialogTitle>
          <DialogDescription>
            Append a row or find rows in a connected spreadsheet.
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
                    </SelectContent>
                  </Select>
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

                <WideOverlayPanel
                  open={mappingOpen}
                  onOpenChange={setMappingOpen}
                  title="Match the columns"
                  description="Map each column to a value or an upstream field. Turn off “May be blank” to require a column."
                >
                  <FieldMapping
                    targets={headers.map((h) => ({ key: h, label: h }))}
                    value={columnMappings}
                    onChange={(next) =>
                      form.setValue("columnMappings", next, {
                        shouldValidate: true,
                      })
                    }
                    currentNodeId={currentNodeId}
                    workflowId={workflowId}
                    anchorClassName="ml-96"
                    renderAccessory={(target) => (
                      <span className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                        <Switch
                          aria-label={`${target.label} may be blank`}
                          checked={!requiredColumns.includes(target.key)}
                          onCheckedChange={(mayBeBlank) =>
                            setRequired(target.key, !mayBeBlank)
                          }
                        />
                        May be blank
                      </span>
                    )}
                  />
                  <p className="mt-4 text-xs text-muted-foreground">
                    To auto-number a column, map it to the “Serial Number” field
                    (the picker’s “Custom” group).
                  </p>
                  <div className="mt-6 flex justify-end">
                    <Button type="button" onClick={() => setMappingOpen(false)}>
                      Done
                    </Button>
                  </div>
                </WideOverlayPanel>
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
