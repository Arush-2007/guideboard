"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "@/components/variable-input";
import { VariableTextarea } from "@/components/variable-textarea";
import { useSmartCredential } from "@/features/credentials/hooks/use-smart-credential";
import { CredentialType } from "@/generated/prisma";
import { useTRPC } from "@/trpc/client";

const formSchema = z
  .object({
    credentialId: z.string().min(1, "Credential is required"),
    action: z.enum(["create_page", "append_to_database"]),
    pageTitle: z.string().min(1, "Page title is required"),
    content: z.string().min(1, "Content is required"),
    parentPageId: z.string().optional(),
    databaseId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "create_page") {
      if (!data.parentPageId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Parent page ID is required",
          path: ["parentPageId"],
        });
      }
    } else if (!data.databaseId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Database ID is required",
        path: ["databaseId"],
      });
    }
  });

export type NotionFormValues = z.infer<typeof formSchema>;

// Sentinel dropdown option that switches the Database field to manual entry, so
// a database ID can be typed or resolved dynamically from an upstream node.
const DATABASE_MANUAL = "__manual__";
// A value that carries a template placeholder can't come from the dropdown, so
// it must be edited in the manual field.
const looksTemplated = (value?: string) => !!value && /@<|{{/.test(value);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: NotionFormValues) => void;
  defaultValues?: Partial<NotionFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const NotionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const trpc = useTRPC();
  const { credentials, isLoading, autoSelected } = useSmartCredential(
    CredentialType.NOTION,
  );
  const { data: notionPages = [], isLoading: isLoadingPages } = useQuery(
    trpc.credentials.getNotionPages.queryOptions(),
  );
  const { data: notionDatabases = [], isLoading: isLoadingDatabases } =
    useQuery(trpc.credentials.getNotionDatabases.queryOptions());

  const form = useForm<NotionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      credentialId: defaultValues.credentialId || "",
      action: defaultValues.action || "create_page",
      pageTitle: defaultValues.pageTitle || "",
      content: defaultValues.content || "",
      parentPageId: defaultValues.parentPageId || "",
      databaseId: defaultValues.databaseId || "",
    },
  });

  // Whether the Database field is in manual/dynamic entry mode vs the dropdown.
  const [databaseManual, setDatabaseManual] = useState(false);

  useEffect(() => {
    if (open) {
      form.reset({
        credentialId: defaultValues.credentialId || "",
        action: defaultValues.action || "create_page",
        pageTitle: defaultValues.pageTitle || "",
        content: defaultValues.content || "",
        parentPageId: defaultValues.parentPageId || "",
        databaseId: defaultValues.databaseId || "",
      });
      // A saved template can only be edited manually; a plain saved ID starts in
      // the dropdown and is reconciled against the list once it loads (below).
      setDatabaseManual(looksTemplated(defaultValues.databaseId));
    }
  }, [open, defaultValues, form]);

  // Once databases load, if the saved ID isn't one of them (e.g. a hand-typed
  // ID or a database not shared with the integration), reveal the manual field
  // so the value stays visible and editable instead of silently hidden.
  useEffect(() => {
    if (!open || databaseManual || isLoadingDatabases) return;
    const id = form.getValues("databaseId");
    if (id && !notionDatabases.some((db) => db.id === id)) {
      setDatabaseManual(true);
    }
  }, [open, databaseManual, isLoadingDatabases, notionDatabases, form]);

  useEffect(() => {
    if (autoSelected) {
      form.setValue("credentialId", autoSelected.id, {
        shouldValidate: true,
      });
    }
  }, [autoSelected, form]);

  const watchAction = form.watch("action");

  const handleSubmit = (values: NotionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notion</DialogTitle>
          <DialogDescription>
            Create a subpage or add a row to a database using the Notion API.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-6 mt-4"
          >
            <FormField
              control={form.control}
              name="credentialId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notion credential</FormLabel>
                  {isLoading ? (
                    <Select value="" disabled>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Loading credentials..." />
                        </SelectTrigger>
                      </FormControl>
                    </Select>
                  ) : credentials.length === 0 ? (
                    <div className="rounded-md border border-yellow-500/40 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                      <p>No NOTION credential found. Set one up first.</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() =>
                          window.open("/credentials/new", "_blank")
                        }
                      >
                        Add Credential
                      </Button>
                    </div>
                  ) : autoSelected ? (
                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      Using: {autoSelected.name}
                    </div>
                  ) : (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select integration token" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {credentials.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            <div className="flex items-center gap-2">
                              <Image
                                src="/logos/notion.svg"
                                alt=""
                                width={16}
                                height={16}
                                unoptimized
                              />
                              {c.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormDescription>
                    Internal integration token from Notion (Credentials).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="action"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="create_page">
                        Create page (under parent page)
                      </SelectItem>
                      <SelectItem value="append_to_database">
                        Append to database
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {watchAction === "create_page" ? (
              <FormField
                control={form.control}
                name="parentPageId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Parent page</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isLoadingPages}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={
                              isLoadingPages
                                ? "Loading pages..."
                                : "Select a parent page"
                            }
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {notionPages.map((page) => (
                          <SelectItem key={page.id} value={page.id}>
                            {page.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Choose one of your accessible Notion pages.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="databaseId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Database</FormLabel>
                    <Select
                      value={databaseManual ? DATABASE_MANUAL : field.value}
                      onValueChange={(value) => {
                        if (value === DATABASE_MANUAL) {
                          setDatabaseManual(true);
                          field.onChange("");
                        } else {
                          setDatabaseManual(false);
                          field.onChange(value);
                        }
                      }}
                      disabled={isLoadingDatabases}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          {databaseManual ? (
                            <span className="flex-1 text-center">
                              Using Database ID
                            </span>
                          ) : (
                            <SelectValue
                              placeholder={
                                isLoadingDatabases
                                  ? "Loading databases..."
                                  : "Select a database"
                              }
                            />
                          )}
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {notionDatabases.map((db) => (
                          <SelectItem key={db.id} value={db.id}>
                            {db.title}
                          </SelectItem>
                        ))}
                        <SelectItem value={DATABASE_MANUAL}>
                          Use database ID…
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {databaseManual ? (
                      <FormControl>
                        <VariableInput
                          placeholder="UUID of the database, or a {{variable}}"
                          className="mt-2 font-mono text-sm"
                          currentNodeId={currentNodeId}
                          workflowId={workflowId}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                    ) : null}
                    <FormDescription>
                      Choose one of your accessible Notion databases, or{" "}
                      <strong>Use database ID</strong> to type an ID or pull one
                      from an upstream node. Title property must be named{" "}
                      <strong>Name</strong> (Notion default).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="pageTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Page / row title</FormLabel>
                  <FormControl>
                    <VariableInput
                      placeholder="{{myTrigger.title}}"
                      className="font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Content</FormLabel>
                  <FormControl>
                    <VariableTextarea
                      placeholder="Paragraphs (blank lines split blocks)"
                      className="min-h-[100px] font-mono text-sm"
                      currentNodeId={currentNodeId}
                      workflowId={workflowId}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Becomes paragraph blocks (max 99). Use {"{{variables}}"}.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="mt-4">
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
