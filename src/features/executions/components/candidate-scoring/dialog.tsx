"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import z from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useCredentialsByType } from "@/features/credentials/hooks/use-credentials";
import { CredentialType } from "@/generated/prisma";

const OPERATORS = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
] as const;

const ruleSchema = z.object({
  label: z.string().optional(),
  field: z.string().min(1, "Field is required"),
  operator: z.enum(OPERATORS),
  value: z.string().optional(),
  points: z.number(),
  required: z.boolean().optional(),
});

const formSchema = z
  .object({
    provider: z.enum(["rules", "affinda"]),
    shortlistThreshold: z.number(),
    reviewThreshold: z.number(),
    rules: z.array(ruleSchema).optional(),
    credentialId: z.string().optional(),
    jobDescriptionId: z.string().optional(),
    resumeId: z.string().optional(),
    indexName: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.provider === "rules") {
      if (!data.rules || data.rules.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Add at least one rule",
          path: ["rules"],
        });
      }
    } else {
      if (!data.credentialId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An Affinda credential is required",
          path: ["credentialId"],
        });
      }
      if (!data.jobDescriptionId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A job description id is required",
          path: ["jobDescriptionId"],
        });
      }
    }
  });

export type CandidateScoringFormValues = z.infer<typeof formSchema>;

/** Number inputs return strings; keep the field value numeric for the schema. */
const toNumber = (value: string): number => (value === "" ? 0 : Number(value));

const DEFAULT_RULE = {
  label: "",
  field: "",
  operator: "contains" as const,
  value: "",
  points: 10,
  required: false,
};

function defaults(
  v: Partial<CandidateScoringFormValues>,
): CandidateScoringFormValues {
  return {
    provider: v.provider ?? "rules",
    shortlistThreshold: v.shortlistThreshold ?? 60,
    reviewThreshold: v.reviewThreshold ?? 35,
    rules: v.rules?.length ? v.rules : [DEFAULT_RULE],
    credentialId: v.credentialId ?? "",
    jobDescriptionId: v.jobDescriptionId ?? "",
    resumeId: v.resumeId ?? "@<RESUME_PARSER_1.affindaResumeId>@",
    indexName: v.indexName ?? "guideboard-resumes",
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CandidateScoringFormValues) => void;
  defaultValues?: Partial<CandidateScoringFormValues>;
  currentNodeId: string;
  workflowId?: string;
}

export const CandidateScoringDialog = ({
  open,
  onOpenChange,
  onSubmit,
  defaultValues = {},
  currentNodeId,
  workflowId,
}: Props) => {
  const form = useForm<CandidateScoringFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(defaultValues),
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "rules",
  });
  const provider = form.watch("provider");
  const { data: credentials = [] } = useCredentialsByType(
    CredentialType.AFFINDA,
  );

  useEffect(() => {
    if (open) form.reset(defaults(defaultValues));
  }, [open, defaultValues, form]);

  const handleSubmit = (values: CandidateScoringFormValues) => {
    onSubmit(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Candidate Scoring</DialogTitle>
          <DialogDescription>
            Score each applicant and decide SHORTLIST / REVIEW / REJECT. Route
            the result with a Switch on this node's{" "}
            <span className="font-mono">decision</span>.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="mt-4 space-y-6"
          >
            <FormField
              control={form.control}
              name="provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="rules">
                        Rules (built-in scorecard)
                      </SelectItem>
                      <SelectItem value="affinda">
                        Affinda (AI fit match)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="shortlistThreshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Shortlist at ≥</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(toNumber(e.target.value))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="reviewThreshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Review at ≥</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(toNumber(e.target.value))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {provider === "rules" ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Scorecard rules</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => append({ ...DEFAULT_RULE })}
                  >
                    <Plus className="mr-1 size-4" /> Add rule
                  </Button>
                </div>
                {fields.map((row, index) => (
                  <div key={row.id} className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <FormField
                        control={form.control}
                        name={`rules.${index}.label`}
                        render={({ field }) => (
                          <FormItem className="flex-1">
                            <FormControl>
                              <Input
                                placeholder="Rule name (e.g. React)"
                                {...field}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(index)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <FormField
                      control={form.control}
                      name={`rules.${index}.field`}
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <VariableInput
                              placeholder="@<applicant.skills>@"
                              currentNodeId={currentNodeId}
                              workflowId={workflowId}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <FormField
                        control={form.control}
                        name={`rules.${index}.operator`}
                        render={({ field }) => (
                          <FormItem>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {OPERATORS.map((op) => (
                                  <SelectItem key={op} value={op}>
                                    {op.replace(/_/g, " ")}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`rules.${index}.value`}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <VariableInput
                                placeholder="React"
                                currentNodeId={currentNodeId}
                                workflowId={workflowId}
                                {...field}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <FormField
                        control={form.control}
                        name={`rules.${index}.points`}
                        render={({ field }) => (
                          <FormItem className="flex items-center gap-2">
                            <FormLabel className="m-0">Points</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                className="w-24"
                                {...field}
                                onChange={(e) =>
                                  field.onChange(toNumber(e.target.value))
                                }
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`rules.${index}.required`}
                        render={({ field }) => (
                          <FormItem className="flex items-center gap-2">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                            <FormLabel className="m-0">
                              Required (knockout)
                            </FormLabel>
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                ))}
                {form.formState.errors.rules?.message ? (
                  <p className="text-sm text-destructive">
                    {String(form.formState.errors.rules.message)}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="credentialId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Affinda credential</FormLabel>
                      {credentials.length === 0 ? (
                        <div className="rounded-md border border-yellow-500/40 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                          <p>No Affinda credential found. Add one first.</p>
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
                      ) : (
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select a credential" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {credentials.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="jobDescriptionId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Job description id (Affinda index)</FormLabel>
                      <FormControl>
                        <Input placeholder="fkAmLQQz" {...field} />
                      </FormControl>
                      <FormDescription>
                        The job description's identifier in your Affinda index.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="resumeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Resume id</FormLabel>
                      <FormControl>
                        <VariableInput
                          placeholder="@<RESUME_PARSER_1.affindaResumeId>@"
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
                  name="indexName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Search &amp; Match index</FormLabel>
                      <FormControl>
                        <Input placeholder="guideboard-resumes" {...field} />
                      </FormControl>
                      <FormDescription>
                        Affinda index the resume is added to before matching.
                        Created automatically if it doesn&apos;t exist.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <DialogFooter className="mt-4">
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
