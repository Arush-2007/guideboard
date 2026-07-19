"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { RestraintsSection } from "@/components/restraints-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { sheetsTriggerOptionsSchemaFields } from "@/lib/sheets-trigger-options";
import { useTRPC } from "@/trpc/client";

const formSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet is required"),
  sheetName: z.string().min(1, "Sheet Name is required"),
  triggerOn: z.enum(["added", "updated", "added_or_updated"]),
  ...sheetsTriggerOptionsSchemaFields,
});

export type GoogleSheetsTriggerFormValues = z.infer<typeof formSchema>;

/** A pickable per-column field, saved so the variable picker can offer it. */
type DiscoveredField = { path: string; label: string };

export type GoogleSheetsTriggerSubmitValues = GoogleSheetsTriggerFormValues & {
  discoveredFields: DiscoveredField[];
};

const TRIGGER_ON_OPTIONS: Array<{
  value: GoogleSheetsTriggerFormValues["triggerOn"];
  label: string;
}> = [
  { value: "added", label: "Row added" },
  { value: "updated", label: "Row updated" },
  { value: "added_or_updated", label: "Row added or updated" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentNodeId: string;
  onSubmit: (values: GoogleSheetsTriggerSubmitValues) => void;
  defaultValues?: Partial<GoogleSheetsTriggerFormValues> & {
    discoveredFields?: DiscoveredField[];
  };
}

export const GoogleSheetsTriggerDialog = ({
  open,
  onOpenChange,
  currentNodeId,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const trpc = useTRPC();
  const { data: sheets = [], isLoading } = useQuery(
    trpc.credentials.getGoogleSheets.queryOptions(),
  );

  const form = useForm<GoogleSheetsTriggerFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      spreadsheetId: defaultValues.spreadsheetId ?? "",
      sheetName: defaultValues.sheetName ?? "Sheet1",
      triggerOn: defaultValues.triggerOn ?? "added_or_updated",
      ignoreColumns: defaultValues.ignoreColumns ?? [],
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        spreadsheetId: defaultValues.spreadsheetId ?? "",
        sheetName: defaultValues.sheetName ?? "Sheet1",
        triggerOn: defaultValues.triggerOn ?? "added_or_updated",
        ignoreColumns: defaultValues.ignoreColumns ?? [],
      });
    }
  }, [open, defaultValues, form]);

  // The trigger's spreadsheet/tab drive the header list for the column picker;
  // reuse the same endpoint the Sheets action's column pickers use.
  const spreadsheetId = form.watch("spreadsheetId");
  const sheetName = form.watch("sheetName");
  const {
    data: columnsData,
    isLoading: columnsLoading,
    isError: columnsError,
  } = useQuery(
    trpc.credentials.getSheetColumns.queryOptions(
      { spreadsheetId, sheetName },
      { enabled: open && !!spreadsheetId && !!sheetName },
    ),
  );
  const headers = columnsData?.headers ?? [];

  const handleSubmit = (values: GoogleSheetsTriggerFormValues) => {
    // Offer each column as a pickable `googleSheets.values.<Header>` field.
    // Rebuild from the freshly-loaded headers; if they haven't loaded, keep what
    // was saved so a quick re-save doesn't wipe the fields.
    const discoveredFields =
      headers.length > 0
        ? headers.map((h) => ({
            path: `googleSheets.values.${h}`,
            label: h,
          }))
        : (defaultValues.discoveredFields ?? []);
    onSubmit({ ...values, discoveredFields });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Trigger this workflow when a row is added to or edited in a sheet.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-6 mt-4"
          >
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
                  <FormLabel>Sheet Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Sheet1" {...field} />
                  </FormControl>
                  <FormDescription>
                    This tab is checked every 5 minutes.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="triggerOn"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Trigger on</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TRIGGER_ON_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {field.value !== "added" && (
                    <FormField
                      control={form.control}
                      name="ignoreColumns"
                      render={({ field: columnsField }) => {
                        // Stored value is the IGNORED columns; a checkbox is
                        // checked when its column is watched, i.e. NOT ignored.
                        const ignored = columnsField.value ?? [];
                        const setWatched = (name: string, watched: boolean) =>
                          columnsField.onChange(
                            watched
                              ? ignored.filter((n) => n !== name)
                              : [...ignored, name],
                          );
                        // Union so an ignored column that's since been renamed
                        // away still shows (as "not found") not silently gone.
                        const options = Array.from(
                          new Set([...headers, ...ignored]),
                        );
                        const noneWatched =
                          options.length > 0 &&
                          options.every((n) => ignored.includes(n));

                        return (
                          <FormItem>
                            <RestraintsSection
                              summary={
                                ignored.length
                                  ? `ignoring ${ignored.join(", ")}`
                                  : null
                              }
                            >
                              <div className="space-y-1">
                                <Label className="text-xs font-normal">
                                  Watch columns for edits
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                  Every column is watched. Uncheck a column to
                                  ignore edits to it.
                                </p>
                              </div>

                              {!spreadsheetId || !sheetName ? (
                                <p className="text-[11px] text-muted-foreground">
                                  Pick a spreadsheet and tab to load its
                                  columns.
                                </p>
                              ) : columnsLoading ? (
                                <p className="text-[11px] text-muted-foreground">
                                  Loading columns…
                                </p>
                              ) : columnsError ? (
                                <p className="text-[11px] text-muted-foreground">
                                  Couldn't read columns. Check the tab name.
                                </p>
                              ) : options.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">
                                  No header row found on this tab.
                                </p>
                              ) : (
                                <>
                                  <div className="space-y-1.5">
                                    {options.map((name) => {
                                      const id = `watch-col-${name}`;
                                      const missing = !headers.includes(name);
                                      return (
                                        <div
                                          key={name}
                                          className="flex items-center gap-2"
                                        >
                                          <Checkbox
                                            id={id}
                                            checked={!ignored.includes(name)}
                                            onCheckedChange={(c) =>
                                              setWatched(name, c === true)
                                            }
                                          />
                                          <Label
                                            htmlFor={id}
                                            className="text-xs font-normal"
                                          >
                                            {name}
                                            {missing && (
                                              <span className="ml-1 text-muted-foreground">
                                                (not found)
                                              </span>
                                            )}
                                          </Label>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {noneWatched && (
                                    <p className="text-[11px] text-amber-600 dark:text-amber-500">
                                      No columns watched — row edits won't
                                      trigger the workflow.
                                    </p>
                                  )}
                                </>
                              )}
                            </RestraintsSection>
                            <FormMessage />
                          </FormItem>
                        );
                      }}
                    />
                  )}

                  <FormDescription>
                    Edits are detected by row position, so this suits sheets
                    that grow at the bottom (form responses, logs).
                    {field.value !== "added" &&
                      " Edits to the first (header) row are ignored."}
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
