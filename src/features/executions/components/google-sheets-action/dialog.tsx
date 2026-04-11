"use client";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/trpc/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";

const formSchema = z
  .object({
    action: z.enum(["append_row", "read_rows"]),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Tab Name is required"),
    range: z.string().min(1, "Range is required"),
    values: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "append_row" && !data.values?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Values are required for append_row",
        path: ["values"],
      });
    }
  });

export type GoogleSheetsActionFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GoogleSheetsActionFormValues) => void;
  defaultValues?: Partial<GoogleSheetsActionFormValues>;
}

export const GoogleSheetsActionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
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
      range: defaultValues.range ?? "A1:D1",
      values: defaultValues.values ?? "",
    },
  });

  const action = form.watch("action");

  useEffect(() => {
    if (open) {
      form.reset({
        action: defaultValues.action ?? "append_row",
        spreadsheetId: defaultValues.spreadsheetId ?? "",
        sheetName: defaultValues.sheetName ?? "Sheet1",
        range: defaultValues.range ?? "A1:D1",
        values: defaultValues.values ?? "",
      });
    }
  }, [open, defaultValues, form]);

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
            className="space-y-6 mt-4"
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
                  <FormLabel>Tab Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Sheet1" {...field} />
                  </FormControl>
                  <FormDescription>
                    The tab name inside your spreadsheet (shown at the bottom
                    of Google Sheets).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="range"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Range</FormLabel>
                  <FormControl>
                    <Input placeholder="A1:D1" {...field} />
                  </FormControl>
                  <FormDescription>
                    Use A1 notation, e.g. A1:D1 or A:Z.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {action === "append_row" ? (
              <FormField
                control={form.control}
                name="values"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Values (JSON)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder='["Alice","alice@example.com","new"]'
                        className="min-h-[100px] font-mono text-sm"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      JSON array for one row, or array of arrays for multiple
                      rows.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
