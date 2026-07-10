"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { FieldMapping } from "@/components/field-mapping";
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
import { VariableInput } from "@/components/variable-input";
import { WideOverlayPanel } from "@/components/wide-overlay-panel";
import { NodeType } from "@/generated/prisma";
import { getOutputKeyForNode } from "@/lib/node-ref";
import { sanitizeHeaderKey } from "@/lib/sheet-headers";
import { useTRPC } from "@/trpc/client";

const formSchema = z
  .object({
    action: z.enum(["append_row", "read_rows"]),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    range: z.string().optional(),
    columnMappings: z.record(z.string(), z.string()).optional(),
    requiredColumns: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "read_rows") {
      if (!data.range?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Range is required to read rows",
          path: ["range"],
        });
      }
      return;
    }
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
  const { data: sheets = [], isLoading } = useQuery(
    trpc.credentials.getGoogleSheets.queryOptions(),
  );

  const form = useForm<GoogleSheetsActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      action: defaultValues.action ?? "append_row",
      spreadsheetId: defaultValues.spreadsheetId ?? "",
      sheetName: defaultValues.sheetName ?? "Sheet1",
      range: defaultValues.range ?? "",
      columnMappings: defaultValues.columnMappings ?? {},
      requiredColumns: defaultValues.requiredColumns ?? [],
    },
  });

  const action = form.watch("action");
  const spreadsheetId = form.watch("spreadsheetId");
  const sheetName = form.watch("sheetName");
  const columnMappings = form.watch("columnMappings") ?? {};
  const requiredColumns = form.watch("requiredColumns") ?? [];

  useEffect(() => {
    if (open) {
      form.reset({
        action: defaultValues.action ?? "append_row",
        spreadsheetId: defaultValues.spreadsheetId ?? "",
        sheetName: defaultValues.sheetName ?? "Sheet1",
        range: defaultValues.range ?? "",
        columnMappings: defaultValues.columnMappings ?? {},
        requiredColumns: defaultValues.requiredColumns ?? [],
      });
    }
  }, [open, defaultValues, form]);

  // Live header row of the chosen spreadsheet/tab → the mapping targets.
  const columnsQuery = useQuery({
    ...trpc.credentials.getSheetColumns.queryOptions({
      spreadsheetId,
      sheetName,
    }),
    enabled:
      action === "append_row" && Boolean(spreadsheetId) && Boolean(sheetName),
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
    if (values.action === "read_rows") {
      payload.discoveredFields = [];
    } else if (headers.length > 0) {
      payload.discoveredFields = headers.map((h) => ({
        path: `${outputKey}.rowByHeader.${sanitizeHeaderKey(h)}`,
        label: h,
      }));
    }
    // else: append_row but columns not yet loaded — omit so the node preserves
    // any previously saved discoveredFields.

    onSubmit(payload);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Google Sheets</DialogTitle>
          <DialogDescription>
            Append a row or read rows from a connected spreadsheet.
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
                      <SelectItem value="read_rows">Read rows</SelectItem>
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
                {columnsQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">
                    Loading columns…
                  </p>
                ) : columnsQuery.isError ? (
                  <p className="text-sm text-destructive">
                    Couldn't read columns. Check the tab name and that your
                    Google account is connected.
                  </p>
                ) : headers.length === 0 && spreadsheetId ? (
                  <p className="text-sm text-muted-foreground">
                    No header row found in row 1 of this tab.
                  </p>
                ) : headers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Pick a spreadsheet and tab to load its columns.
                  </p>
                ) : (
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
                )}
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
                </WideOverlayPanel>
              </div>
            ) : (
              <FormField
                control={form.control}
                name="range"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Range</FormLabel>
                    <FormControl>
                      <VariableInput
                        placeholder="A1:D100"
                        currentNodeId={currentNodeId}
                        workflowId={workflowId}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      The A1 range to read, e.g. A1:D100.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
