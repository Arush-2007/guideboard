"use client";

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
import { Textarea } from "@/components/ui/textarea";
import z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Image from "next/image";

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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: NotionFormValues) => void;
  defaultValues?: Partial<NotionFormValues>;
}

export const NotionDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const { data: credentials, isLoading: isLoadingCredentials } =
    useCredentialsByType(CredentialType.NOTION);

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
    }
  }, [open, defaultValues, form]);

  const watchAction = form.watch("action");

  const handleSubmit = (values: NotionFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isLoadingCredentials}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select integration token" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(credentials ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <div className="flex items-center gap-2">
                            <Image
                              src="/logos/notion.svg"
                              alt=""
                              width={16}
                              height={16}
                            />
                            {c.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                  >
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
                    <FormLabel>Parent page ID</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="UUID of the parent page"
                        className="font-mono text-sm"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Supports {"{{templates}}"}. From page → Share → Copy link
                      (ID in URL).
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
                    <FormLabel>Database ID</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="UUID of the database"
                        className="font-mono text-sm"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Title property must be named{" "}
                      <strong>Name</strong> (Notion default). Supports{" "}
                      {"{{templates}}"}.
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
                    <Input
                      placeholder="{{myTrigger.title}}"
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
              name="content"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Content</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Paragraphs (blank lines split blocks)"
                      className="min-h-[100px] font-mono text-sm"
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
