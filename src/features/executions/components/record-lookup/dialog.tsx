"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
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
import { VariableInput } from "@/components/variable-input";
import { useSmartCredential } from "@/features/credentials/hooks/use-smart-credential";
import { CredentialType } from "@/generated/prisma";
import { useTRPC } from "@/trpc/client";

const formSchema = z
  .object({
    source: z.enum(["google_sheets", "notion"]),
    value: z.string().min(1, "A value to search for is required"),
    // google_sheets
    spreadsheetId: z.string().optional(),
    sheetName: z.string().optional(),
    column: z.string().optional(),
    // notion
    credentialId: z.string().optional(),
    databaseId: z.string().optional(),
    property: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.source === "google_sheets") {
      if (!data.spreadsheetId?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Spreadsheet is required",
          path: ["spreadsheetId"],
        });
      if (!data.sheetName?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Tab name is required",
          path: ["sheetName"],
        });
      if (!data.column?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Column is required",
          path: ["column"],
        });
    } else {
      if (!data.credentialId?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A Notion credential is required",
          path: ["credentialId"],
        });
      if (!data.databaseId?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Database ID is required",
          path: ["databaseId"],
        });
      if (!data.property?.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Property is required",
          path: ["property"],
        });
    }
  });

export type RecordLookupFormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: RecordLookupFormValues) => void;
  defaultValues?: Partial<RecordLookupFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const RecordLookupDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const trpc = useTRPC();
  const { data: sheets = [], isLoading: sheetsLoading } = useQuery(
    trpc.credentials.getGoogleSheets.queryOptions(),
  );
  const { credentials: notionCreds, autoSelected } = useSmartCredential(
    CredentialType.NOTION,
  );

  const form = useForm<RecordLookupFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      source: defaultValues.source ?? "google_sheets",
      value: defaultValues.value ?? "",
      spreadsheetId: defaultValues.spreadsheetId ?? "",
      sheetName: defaultValues.sheetName ?? "",
      column: defaultValues.column ?? "",
      credentialId: defaultValues.credentialId ?? "",
      databaseId: defaultValues.databaseId ?? "",
      property: defaultValues.property ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        source: defaultValues.source ?? "google_sheets",
        value: defaultValues.value ?? "",
        spreadsheetId: defaultValues.spreadsheetId ?? "",
        sheetName: defaultValues.sheetName ?? "",
        column: defaultValues.column ?? "",
        credentialId: defaultValues.credentialId ?? "",
        databaseId: defaultValues.databaseId ?? "",
        property: defaultValues.property ?? "",
      });
    }
  }, [open, defaultValues, form]);

  useEffect(() => {
    if (autoSelected && !form.getValues("credentialId")) {
      form.setValue("credentialId", autoSelected.id, { shouldValidate: true });
    }
  }, [autoSelected, form]);

  const source = form.watch("source");

  const handleSubmit = (values: RecordLookupFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Lookup</DialogTitle>
          <DialogDescription>
            Check whether a value exists in a spreadsheet column or a Notion
            database property. Outputs <span className="font-mono">exists</span>{" "}
            (true/false) — pair it with a Condition node to branch.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="source"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Where to look</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="google_sheets">
                        Google Sheets
                      </SelectItem>
                      <SelectItem value="notion">Notion database</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {source === "google_sheets" ? (
              <>
                <FormField
                  control={form.control}
                  name="spreadsheetId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Spreadsheet</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={sheetsLoading}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue
                              placeholder={
                                sheetsLoading
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
                        <Input placeholder="Applicants" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="column"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Column to search</FormLabel>
                      <FormControl>
                        <Input placeholder="Email" {...field} />
                      </FormControl>
                      <FormDescription>
                        The row-1 header of the column to match against.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            ) : (
              <>
                <FormField
                  control={form.control}
                  name="credentialId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notion credential</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select integration token" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {notionCreds.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
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
                  name="databaseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Database ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="UUID of the database"
                          className="font-mono text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="property"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property to search</FormLabel>
                      <FormControl>
                        <Input placeholder="Email" {...field} />
                      </FormControl>
                      <FormDescription>
                        The database property name (title, text, email, url,
                        number…).
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <FormField
              control={form.control}
              name="value"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Value to find</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="@<googleForm.responses.Email>@"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Insert an upstream value with the{" "}
                    <span className="font-mono">{"{ }"}</span> button.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
