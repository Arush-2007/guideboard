"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { useDanglingRefGuard } from "@/components/dangling-ref-guard";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { FieldMapping } from "@/components/field-mapping";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "@/components/variable-input";
import { useTRPC } from "@/trpc/client";

const formSchema = z
  .object({
    operation: z.enum(["append_row", "upsert_by_key"]),
    workbookId: z.string().min(1, "Workbook is required"),
    worksheetName: z.string().min(1, "Worksheet is required"),
    columnMappings: z.record(z.string(), z.string()).optional(),
    keyColumn: z.string().optional(),
    keyValue: z.string().optional(),
    columnModes: z.record(z.string(), z.enum(["set", "add"])).optional(),
  })
  .superRefine((data, ctx) => {
    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;
    if (!hasMappings) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Map at least one column",
        path: ["columnMappings"],
      });
    }
    if (data.operation === "upsert_by_key") {
      if (!data.keyColumn?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pick the column to match rows by",
          path: ["keyColumn"],
        });
      }
      if (!data.keyValue?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A key value is required",
          path: ["keyValue"],
        });
      }
    }
  });

export type ExcelActionFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ExcelActionFormValues) => void;
  defaultValues?: Partial<ExcelActionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const ExcelActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const trpc = useTRPC();
  const { data: workbooks = [], isLoading: workbooksLoading } = useQuery(
    trpc.credentials.getExcelWorkbooks.queryOptions(),
  );

  const form = useForm<ExcelActionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      operation: defaultValues.operation ?? "append_row",
      workbookId: defaultValues.workbookId ?? "",
      worksheetName: defaultValues.worksheetName ?? "",
      columnMappings: defaultValues.columnMappings ?? {},
      keyColumn: defaultValues.keyColumn ?? "",
      keyValue: defaultValues.keyValue ?? "",
      columnModes: defaultValues.columnModes ?? {},
    },
  });

  const operation = form.watch("operation");
  const workbookId = form.watch("workbookId");
  const worksheetName = form.watch("worksheetName");
  const columnMappings = form.watch("columnMappings") ?? {};
  const columnModes = form.watch("columnModes") ?? {};

  useEffect(() => {
    if (open) {
      form.reset({
        operation: defaultValues.operation ?? "append_row",
        workbookId: defaultValues.workbookId ?? "",
        worksheetName: defaultValues.worksheetName ?? "",
        columnMappings: defaultValues.columnMappings ?? {},
        keyColumn: defaultValues.keyColumn ?? "",
        keyValue: defaultValues.keyValue ?? "",
        columnModes: defaultValues.columnModes ?? {},
      });
    }
  }, [open, defaultValues, form]);

  const worksheetsQuery = useQuery({
    ...trpc.credentials.getExcelWorksheets.queryOptions({ workbookId }),
    enabled: Boolean(workbookId),
  });
  const worksheets = worksheetsQuery.data ?? [];

  // Header columns of the worksheet's Table → the mapping targets.
  // tableName === null means the sheet has no Excel Table yet.
  const columnsQuery = useQuery({
    ...trpc.credentials.getExcelColumns.queryOptions({
      workbookId,
      worksheetName,
    }),
    enabled: Boolean(workbookId) && Boolean(worksheetName),
  });
  const headers = columnsQuery.data?.headers ?? [];
  const hasTable = columnsQuery.data?.tableName != null;

  const mappedHeaders = headers.filter((h) => columnMappings[h]?.trim());

  const handleSubmit = (values: ExcelActionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  const guard = useDanglingRefGuard({ currentNodeId, onSave: handleSubmit });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Append a row, or update a matching row, in an Excel workbook on your
            OneDrive.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(guard.save)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="operation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Operation</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select operation" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="append_row">Append row</SelectItem>
                      <SelectItem value="upsert_by_key">
                        Upsert by key (update matching row, or insert)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="workbookId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Workbook</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={workbooksLoading}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            workbooksLoading
                              ? "Loading workbooks..."
                              : "Select a workbook"
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {workbooks.map((workbook) => (
                        <SelectItem key={workbook.id} value={workbook.id}>
                          {workbook.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    .xlsx files on the OneDrive of your connected Microsoft work
                    account.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="worksheetName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Worksheet</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!workbookId || worksheetsQuery.isLoading}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            worksheetsQuery.isLoading
                              ? "Loading worksheets..."
                              : "Select a worksheet"
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {worksheets.map((sheet) => (
                        <SelectItem key={sheet.id} value={sheet.name}>
                          {sheet.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <Label>Match the columns</Label>
              {columnsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Loading columns…
                </p>
              ) : columnsQuery.isError ? (
                <p className="text-sm text-destructive">
                  Couldn't read columns. Check that your Microsoft account is
                  connected and the workbook still exists.
                </p>
              ) : worksheetName && !hasTable ? (
                <p className="text-sm text-destructive">
                  This worksheet has no Excel Table. In Excel, select your data
                  (including the header row) and press Ctrl+T, then reopen this
                  dialog.
                </p>
              ) : (
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
                />
              )}
              {form.formState.errors.columnMappings?.message ? (
                <p className="text-sm text-destructive">
                  {String(form.formState.errors.columnMappings.message)}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A serial-number column (e.g. "S.No") is filled automatically
                  if you leave it unmapped.
                </p>
              )}
            </div>

            {operation === "upsert_by_key" && (
              <>
                <FormField
                  control={form.control}
                  name="keyColumn"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Key column</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={headers.length === 0}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Column to match rows by" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {headers.map((header) => (
                            <SelectItem key={header} value={header}>
                              {header}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        The first row whose value here equals the key value is
                        updated; if none matches, a new row is inserted.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="keyValue"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Key value</FormLabel>
                      <FormControl>
                        <VariableInput
                          placeholder="e.g. @<googleForm.responses.Service Buyer>@"
                          currentNodeId={currentNodeId}
                          workflowId={workflowId}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {mappedHeaders.length > 0 && (
                  <div className="space-y-2">
                    <Label>When a row matches</Label>
                    <div className="space-y-2">
                      {mappedHeaders.map((header) => (
                        <div
                          key={header}
                          className="flex items-center justify-between gap-3"
                        >
                          <span className="min-w-0 truncate text-sm">
                            {header}
                          </span>
                          <Select
                            value={columnModes[header] ?? "set"}
                            onValueChange={(mode) =>
                              form.setValue(
                                "columnModes",
                                {
                                  ...columnModes,
                                  [header]: mode as "set" | "add",
                                },
                                { shouldValidate: true },
                              )
                            }
                          >
                            <SelectTrigger className="w-44 shrink-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="set">Overwrite</SelectItem>
                              <SelectItem value="add">
                                Add to existing number
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      "Add to existing number" accumulates values — e.g. a
                      running total of estimated amounts per buyer.
                    </p>
                  </div>
                )}
              </>
            )}

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
