"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
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
import { VariableInput } from "@/components/variable-input";
import { useTRPC } from "@/trpc/client";

const formSchema = z
  .object({
    action: z.enum(["append_row", "read_rows"]),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab name is required"),
    range: z.string().optional(),
    columnMappings: z.record(z.string(), z.string()).optional(),
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GoogleSheetsActionFormValues) => void;
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
    },
  });

  const action = form.watch("action");
  const spreadsheetId = form.watch("spreadsheetId");
  const sheetName = form.watch("sheetName");
  const columnMappings = form.watch("columnMappings") ?? {};

  useEffect(() => {
    if (open) {
      form.reset({
        action: defaultValues.action ?? "append_row",
        spreadsheetId: defaultValues.spreadsheetId ?? "",
        sheetName: defaultValues.sheetName ?? "Sheet1",
        range: defaultValues.range ?? "",
        columnMappings: defaultValues.columnMappings ?? {},
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

  const handleSubmit = (values: GoogleSheetsActionFormValues) => {
    onSubmit(values);
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
                    To auto-number a column, map it to the “Serial Number” field
                    (the picker’s “Custom” group).
                  </p>
                )}
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
