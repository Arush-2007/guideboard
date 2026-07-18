"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2Icon,
  ClockIcon,
  CopyIcon,
  Loader2Icon,
  RedoIcon,
  RotateCwIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { useSuspenseExecution } from "@/features/executions/hooks/use-executions";
import {
  COMPARE_OPERATOR_LABELS,
  type CompareOperator,
  describeCompareOptions,
  pickCompareOptions,
} from "@/features/executions/lib/compare";
import { formatDuration } from "@/features/executions/lib/format-duration";
import {
  ExecutionStatus,
  NodeExecutionStatus,
  NodeType,
} from "@/generated/prisma";
import {
  describeConfigValue,
  getNodeOutputRoot,
  type Producer,
  renderReferences,
  resolveFriendlyInput,
  resolveFriendlyOutput,
  resolveReferencedInput,
} from "@/lib/friendly-output";
import { nodeSummaries } from "@/lib/node-output-summary";
import { NON_REF_NODE_TYPES } from "@/lib/node-ref";
import {
  ROW_MATCH_OPERATOR_LABELS,
  type RowMatchOperator,
  VALUELESS_ROW_MATCH_OPERATORS,
} from "@/lib/row-match-operators";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";

// Both ExecutionStatus and NodeExecutionStatus share the same string members
// (RUNNING/SUCCESS/FAILED), so one icon map serves both.
const getStatusIcon = (status: string) => {
  switch (status) {
    case ExecutionStatus.SUCCESS:
      return <CheckCircle2Icon className="size-5 text-green-600" />;
    case ExecutionStatus.FAILED:
      return <XCircleIcon className="size-5 text-red-600" />;
    case ExecutionStatus.RUNNING:
      return <Loader2Icon className="size-5 text-blue-600 animate-spin" />;
    default:
      return <ClockIcon className="size-5 text-muted-foreground" />;
  }
};

const formatStatus = (status: string) => {
  return status.charAt(0) + status.slice(1).toLowerCase();
};

const RerunButton = ({ executionId }: { executionId: string }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const rerun = useMutation(
    trpc.executions.rerun.mutationOptions({
      onSuccess: () => {
        toast.success("Re-run started");
        queryClient.invalidateQueries(trpc.executions.getMany.queryOptions({}));
      },
      onError: (error) => {
        toast.error(`Failed to re-run: ${error.message}`);
      },
    }),
  );

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={rerun.isPending}
      onClick={() => rerun.mutate({ id: executionId })}
    >
      <RotateCwIcon className="size-4" />
      {rerun.isPending ? "Starting…" : "Re-run"}
    </Button>
  );
};

// Re-runs the workflow starting at this node, reusing the context the node
// received the first time — so the user can fix one node and replay forward
// without re-running expensive upstream nodes. Hidden for skipped nodes (they
// never ran, so there's nothing to replay from).
const ReplayFromNodeButton = ({
  executionId,
  nodeId,
}: {
  executionId: string;
  nodeId: string;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const replay = useMutation(
    trpc.executions.replayFromNode.mutationOptions({
      onSuccess: () => {
        toast.success("Replay started from this node");
        queryClient.invalidateQueries(trpc.executions.getMany.queryOptions({}));
      },
      onError: (error) => {
        toast.error(`Failed to replay: ${error.message}`);
      },
    }),
  );

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2"
      disabled={replay.isPending}
      onClick={() => replay.mutate({ executionId, nodeId })}
    >
      <RedoIcon className="size-3.5" />
      {replay.isPending ? "Starting…" : "Replay from here"}
    </Button>
  );
};

// Copies a data block's raw, pretty-printed JSON (the exact values, not the
// friendly rendering) to the clipboard. Mirrors the app's copy convention (see
// webhook-trigger dialog): write + toast, no transient state.
const CopyJsonButton = ({ value }: { value: unknown }) => {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      toast.success("Copied");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs"
      onClick={handleCopy}
    >
      <CopyIcon className="size-3.5" />
      Copy
    </Button>
  );
};

// Scalars render inline; objects/arrays stay as compact JSON so nested shapes
// (a shared contact, an appended row) are still legible without a Raw switch.
const FriendlyValue = ({ value }: { value: unknown }) => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return <span className="text-sm break-words">{String(value)}</span>;
  }
  return (
    <pre className="text-xs font-mono overflow-auto rounded bg-background p-1.5 max-h-40">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
};

// A Field | Value table for one source node's curated fields.
const FieldTable = ({
  rows,
}: {
  rows: { label: string; value: unknown }[];
}) => (
  <div className="overflow-hidden rounded-md border">
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="border-b bg-muted/60 text-xs text-muted-foreground">
          <th className="w-1/3 px-2 py-1 text-left font-medium">Field</th>
          <th className="px-2 py-1 text-left font-medium">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-b align-top last:border-b-0">
            <td className="w-1/3 break-words px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {row.label}
            </td>
            <td className="px-2 py-1.5">
              <FriendlyValue value={row.value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// A multi-column grid for a find_rows result: every column × matching rows.
// Scrolls horizontally; display capped at 50 rows (stored output is ≤100).
// `actedRowIndex` paints the row THIS run acted on green, so the user can tell
// which of several matches this particular workflow run was for.
// `rowLabels` adds a leading label column (the same one RowChangeGrid uses) —
// the insert action labels each added row with the sheet row it landed on.
// `rowColors` (color_rows) shows the #RRGGBB each row was actually painted as a
// swatch in that same label column — the one thing a plain text grid can't say
// about a coloring run.
const RowsGrid = ({
  columns,
  rows,
  actedRowIndex = null,
  rowLabels = null,
  rowColors = null,
}: {
  columns: string[];
  rows: Record<string, string>[];
  actedRowIndex?: number | null;
  rowLabels?: string[] | null;
  rowColors?: string[] | null;
}) => {
  const shown = rows.slice(0, 50);
  return (
    <div className="space-y-1">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/60 text-xs text-muted-foreground">
              {rowLabels ? (
                <th className="w-20 px-2 py-1 text-left font-medium" />
              ) : null}
              {columns.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap px-2 py-1 text-left font-medium"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: static read-only result rows, never reordered.
                key={i}
                className={cn(
                  "border-b align-top last:border-b-0",
                  i === actedRowIndex && "bg-green-50 text-green-900",
                )}
              >
                {rowLabels ? (
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      {rowColors?.[i] ? (
                        <span
                          className="size-3 shrink-0 rounded-sm border"
                          style={{ backgroundColor: rowColors[i] }}
                          title={rowColors[i]}
                        />
                      ) : null}
                      {rowLabels[i] ?? ""}
                    </span>
                  </td>
                ) : null}
                {columns.map((col) => (
                  <td key={col} className="break-words px-2 py-1.5 text-xs">
                    {row[col] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {actedRowIndex !== null && actedRowIndex < shown.length ? (
        <p className="text-xs text-green-700">
          The green row is the one this run acted on.
        </p>
      ) : null}
      {rows.length > shown.length ? (
        <p className="text-xs italic text-muted-foreground">
          +{rows.length - shown.length} more — switch to Raw to see all.
        </p>
      ) : null}
    </div>
  );
};

// A written row as a spreadsheet would show it: the sheet's columns across the
// top, and either the single row that was added, or the row BEFORE the write and
// the row AFTER it stacked underneath with every changed cell highlighted.
const RowChangeGrid = ({
  columns,
  before,
  after,
  singleRowLabel = null,
  contextRow = null,
}: {
  columns: string[];
  before: Record<string, string>;
  after: Record<string, string>;
  /**
   * When set, there is no prior state to diff against — a row that was just
   * added, or a fan-out child whose reshaped output carries only its own row.
   * `after` then renders alone under this label.
   */
  singleRowLabel?: string | null;
  /**
   * An existing row shown ABOVE the added one purely as context, never diffed:
   * the insert action's anchor — the row the new one was placed under. Only
   * meaningful alongside `singleRowLabel`, since a row that was ADDED has no
   * prior state of its own to compare against.
   */
  contextRow?: { label: string; cells: Record<string, string> } | null;
}) => {
  const rows = singleRowLabel
    ? [
        ...(contextRow
          ? [
              {
                label: contextRow.label,
                cells: contextRow.cells,
                diff: false,
                added: false,
              },
            ]
          : []),
        { label: singleRowLabel, cells: after, diff: false, added: true },
      ]
    : [
        { label: "Before", cells: before, diff: false, added: false },
        { label: "After", cells: after, diff: true, added: false },
      ];

  // With a context row above it, the added row is highlighted whole — every one
  // of its cells is new. (A lone added row needs no highlight: there is nothing
  // to tell it apart FROM.) Green means "what this run wrote", as it does in the
  // diff view and in RowsGrid's acted-row.
  const highlightAdded = Boolean(singleRowLabel && contextRow);

  // Re-running a workflow rewrites the same values, so a diff view can legitimately
  // have ZERO changed cells. Saying "green cells are the ones that changed" with
  // nothing green reads as a bug — say what actually happened instead.
  const changedCount = singleRowLabel
    ? 0
    : columns.filter((col) => before[col] !== after[col]).length;

  return (
    <div className="space-y-1">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/60 text-xs text-muted-foreground">
              <th className="w-16 px-2 py-1 text-left font-medium" />
              {columns.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap px-2 py-1 text-left font-medium"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.label}
                className="border-b align-top last:border-b-0"
              >
                <td className="whitespace-nowrap px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {row.label}
                </td>
                {columns.map((col) => {
                  // Only cells whose value actually moved are highlighted — an
                  // unmapped column is written as null (left untouched), so it
                  // must not look like the run changed it.
                  const isChanged = row.diff && before[col] !== after[col];
                  return (
                    <td
                      key={col}
                      className={cn(
                        "break-words px-2 py-1.5 text-xs",
                        (isChanged || (highlightAdded && row.added)) &&
                          "bg-green-50 font-medium text-green-900",
                      )}
                    >
                      {row.cells[col] ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {singleRowLabel ? (
        highlightAdded ? (
          <p className="text-xs text-green-700">
            The green row is the one this step added. It was placed directly
            under the row above it.
          </p>
        ) : null
      ) : changedCount > 0 ? (
        <p className="text-xs text-green-700">
          {changedCount === 1
            ? "1 cell changed (highlighted green). Every other cell was left as it was."
            : `${changedCount} cells changed (highlighted green). Every other cell was left as it was.`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No cell changed — the row already held these exact values.
        </p>
      )}
    </div>
  );
};

type DisplayCondition = {
  id?: string;
  column?: string;
  operator?: string;
  value?: string;
  enabled?: boolean;
  ignoreCase?: boolean;
  ignoreChars?: string;
  numeric?: boolean;
};

const CONDITION_TONES = {
  matched: {
    frame: "border-green-300 text-green-800",
    row: "border-green-200",
    header: "bg-green-50",
  },
  danger: {
    frame: "border-red-300 text-red-800",
    row: "border-red-200",
    header: "bg-red-50",
  },
  muted: {
    frame: "border-border text-muted-foreground",
    row: "border-border",
    header: "bg-muted/60",
  },
} as const;

// The row filter as a Field | Operator | Value table — shared by every action
// that selects rows the same way. Green when rows matched; when none did, red by
// default, because for find_rows and update_row that means nothing was read or
// written. Actions where matching nothing is a perfectly good outcome
// (insert_row_adjacent starts a new group) pass `unmatchedTone="muted"`, so a
// normal run is never dressed up as a failure.
const RowConditionsTable = ({
  conditions,
  input,
  unmatched,
  unmatchedLabel = "No rows matched these conditions:",
  unmatchedTone = "danger",
}: {
  conditions: DisplayCondition[];
  input: unknown;
  unmatched: boolean;
  unmatchedLabel?: string;
  unmatchedTone?: "danger" | "muted";
}) => {
  const active = conditions.filter(
    (c) => c.enabled !== false && c.column?.trim(),
  );
  if (active.length === 0) return null;
  const tone = CONDITION_TONES[unmatched ? unmatchedTone : "matched"];
  const rowBorder = tone.row;
  return (
    <div
      className={cn("overflow-hidden rounded-md border text-xs", tone.frame)}
    >
      <div className={cn("px-2 py-1 font-medium", tone.header)}>
        {unmatched ? unmatchedLabel : "Conditions applied — rows matched:"}
      </div>
      <table className="w-full table-fixed">
        <thead>
          <tr
            className={cn(
              "border-t text-left text-muted-foreground",
              rowBorder,
            )}
          >
            <th className="w-1/3 px-2 py-1 font-medium">Field</th>
            <th className="w-1/4 px-2 py-1 font-medium">Operator</th>
            <th className="px-2 py-1 font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {active.map((c) => {
            const op = c.operator as RowMatchOperator | undefined;
            const opLabel = op ? (ROW_MATCH_OPERATOR_LABELS[op] ?? op) : "";
            const valueless = op
              ? VALUELESS_ROW_MATCH_OPERATORS.has(op)
              : false;
            const resolved = valueless ? "—" : renderReferences(c.value, input);
            const optsNote = describeCompareOptions(pickCompareOptions(c), op);
            return (
              <tr
                key={c.id ?? `${c.column}-${c.operator}`}
                className={cn("border-t align-top", rowBorder)}
              >
                <td className="break-words px-2 py-1 font-medium">
                  {c.column}
                </td>
                <td className="px-2 py-1">
                  {opLabel}
                  {optsNote ? (
                    <span className="block text-[11px] text-muted-foreground">
                      {optsNote}
                    </span>
                  ) : null}
                </td>
                <td className="break-words px-2 py-1">{resolved}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const EmptyFriendly = () => (
  <p className="rounded bg-muted p-2 text-xs italic text-muted-foreground">
    No recognized fields in this run — switch to Raw to see everything.
  </p>
);

// A short status line shown in place of an output table when there's no table to
// show (a failed/skipped node, or a success that produced no data fields).
const StatusNote = ({
  variant = "muted",
  children,
}: {
  variant?: "muted" | "error";
  children: ReactNode;
}) => (
  <p
    className={cn(
      "rounded p-2 text-xs",
      variant === "error"
        ? "bg-red-50 text-red-800"
        : "bg-muted italic text-muted-foreground",
    )}
  >
    {children}
  </p>
);

// The one-line "what happened" summary shown above an output table.
const SummaryMessage = ({ children }: { children: ReactNode }) => (
  <p className="text-sm">{children}</p>
);

// Renders friendly input groups (one labeled table per source node).
const SourceTables = ({
  sources,
}: {
  sources: {
    key: string;
    label: string;
    fields: { label: string; value: unknown }[];
  }[];
}) => (
  <div className="space-y-2">
    {sources.map((source) => (
      <div key={source.key}>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {source.label}
        </p>
        <FieldTable rows={source.fields} />
      </div>
    ))}
  </div>
);

// Builds the Field / Operator / Value rows for a branching comparison (a
// Condition, or one Switch case). Each operand is labeled by where it came from —
// the upstream field's name if referenced, or "Entered by user" for a literal.
const criteriaRows = (
  cfg: {
    field?: unknown;
    operator?: unknown;
    value?: unknown;
    ignoreCase?: boolean;
    ignoreChars?: string;
    numeric?: boolean;
  },
  input: unknown,
  producers: Producer[],
  runNodeTypes: string[],
): { label: string; value: unknown }[] => {
  const operator = typeof cfg.operator === "string" ? cfg.operator : "";
  const field = describeConfigValue(cfg.field, input, producers, runNodeTypes);
  const opLabel =
    COMPARE_OPERATOR_LABELS[operator as CompareOperator] ?? operator;
  const optsNote = describeCompareOptions(pickCompareOptions(cfg), operator);
  const rows = [
    { label: field.label, value: field.value },
    {
      label: "Operator",
      value: optsNote ? `${opLabel} — ${optsNote}` : opLabel,
    },
  ];
  // is_empty / is_not_empty take no comparison value.
  if (operator !== "is_empty" && operator !== "is_not_empty") {
    const compared = describeConfigValue(
      cfg.value,
      input,
      producers,
      runNodeTypes,
    );
    rows.push({ label: compared.label, value: compared.value });
  }
  return rows;
};

// A labeled data section (Input / Output) that shows the friendly field tables by
// default with a Raw toggle to the full JSON. `friendly` is null when the data
// can't be projected (no declared contract / not an object), in which case only
// Raw is shown — the friendly view self-degrades instead of inventing fields.
const DataSection = ({
  label,
  raw,
  friendly,
}: {
  label: string;
  raw: unknown;
  friendly: ReactNode | null;
}) => {
  const [showRaw, setShowRaw] = useState(false);
  const hasFriendly = friendly !== null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="flex items-center gap-1">
          {hasFriendly ? (
            <>
              <Button
                variant={showRaw ? "ghost" : "secondary"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setShowRaw(false)}
              >
                Friendly
              </Button>
              <Button
                variant={showRaw ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setShowRaw(true)}
              >
                Raw
              </Button>
            </>
          ) : null}
          <CopyJsonButton value={raw} />
        </div>
      </div>

      {hasFriendly && !showRaw ? (
        friendly
      ) : (
        <pre className="text-xs font-mono overflow-auto rounded bg-muted p-2 max-h-64">
          {JSON.stringify(raw, null, 2)}
        </pre>
      )}
    </div>
  );
};

type NodeExecutionRow = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

const NodeRow = ({
  node,
  executionId,
  producers,
  runNodeTypes,
  config,
}: {
  node: NodeExecutionRow;
  executionId: string;
  producers: Producer[];
  runNodeTypes: string[];
  /** This node's saved config (`data`), used to find the fields it references. */
  config: Record<string, unknown> | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const isSkipped = node.status === NodeExecutionStatus.SKIPPED;
  const isTrigger = NON_REF_NODE_TYPES.has(node.nodeType);

  // Input. A trigger has no upstream, so it shows its own payload (user-relevant
  // fields only). A middle node shows ONLY the upstream fields it references in
  // its config — resolved to this run's values — not the whole context.
  const inputFriendly = useMemo<ReactNode | null>(() => {
    if (isTrigger) {
      const sources = resolveFriendlyInput(node.input, producers, runNodeTypes);
      if (sources === null) return null;
      if (sources.length === 0) return <EmptyFriendly />;
      return <SourceTables sources={sources} />;
    }
    // A Condition's input is the comparison it evaluated: field, operator, value
    // — each operand labeled by where it came from.
    if (node.nodeType === NodeType.CONDITION) {
      return (
        <FieldTable
          rows={criteriaRows(config ?? {}, node.input, producers, runNodeTypes)}
        />
      );
    }
    const sources = resolveReferencedInput(
      config,
      node.input,
      producers,
      runNodeTypes,
    );
    if (sources.length === 0) {
      return (
        <StatusNote>
          This step didn't use any data from previous steps.
        </StatusNote>
      );
    }
    return <SourceTables sources={sources} />;
  }, [isTrigger, node.nodeType, config, node.input, producers, runNodeTypes]);

  // Output. Status first (failed/skipped get a note), then a per-node "what
  // happened" summary line plus the details table. Triggers just announce the run.
  const outputFriendly = useMemo<ReactNode | null>(() => {
    if (node.status === NodeExecutionStatus.SKIPPED) {
      return (
        <StatusNote>
          Skipped — an earlier branch didn't reach this node, so it never ran.
        </StatusNote>
      );
    }
    if (node.status === NodeExecutionStatus.FAILED) {
      return (
        <StatusNote variant="error">
          This node failed, so it produced no output.
        </StatusNote>
      );
    }
    if (isTrigger) {
      return <SummaryMessage>Workflow was triggered.</SummaryMessage>;
    }
    // A Condition's output is just its verdict — no table.
    if (node.nodeType === NodeType.CONDITION) {
      const result = getNodeOutputRoot(node.nodeType, node.output)?.result;
      if (typeof result === "boolean") {
        return <SummaryMessage>{result ? "True" : "False"}</SummaryMessage>;
      }
      return <StatusNote>No result was recorded for this run.</StatusNote>;
    }
    // A Switch announces the matched branch; for a real case it also shows the
    // case's field/operator/value (reconstructed from config), default shows none.
    if (node.nodeType === NodeType.SWITCH) {
      const matched = getNodeOutputRoot(node.nodeType, node.output)?.matched;
      if (typeof matched !== "string") {
        return <StatusNote>No branch was recorded for this run.</StatusNote>;
      }
      if (matched === "Default") {
        return (
          <SummaryMessage>
            No case matched — the default branch ran.
          </SummaryMessage>
        );
      }
      // "Case N" → the Nth configured case (1-based).
      const index = Number(matched.replace(/^Case\s+/, "")) - 1;
      const cases = Array.isArray(config?.cases) ? config.cases : [];
      const matchedCase = cases[index] as
        | { field?: unknown; operator?: unknown; value?: unknown }
        | undefined;
      return (
        <div className="space-y-2">
          <SummaryMessage>{matched} matched.</SummaryMessage>
          {matchedCase ? (
            <FieldTable
              rows={criteriaRows(
                matchedCase,
                node.input,
                producers,
                runNodeTypes,
              )}
            />
          ) : null}
        </div>
      );
    }

    // Every Google Sheets action renders its own summary + a spreadsheet-shaped
    // view here — never a Field | Value table of JSON blobs. The summary must be
    // true for EVERY outcome; in particular it may never imply a write happened
    // when no row matched. `nodeSummaries` deliberately has NO entry for this
    // node type, so nothing can contradict what is said below.
    if (node.nodeType === NodeType.GOOGLE_SHEETS_ACTION) {
      const root = getNodeOutputRoot(node.nodeType, node.output);
      const tab =
        typeof root?.sheetName === "string" && root.sheetName.trim()
          ? `“${root.sheetName.trim()}”`
          : "the sheet";
      const conditionRows = Array.isArray(config?.conditions)
        ? (config.conditions as DisplayCondition[])
        : [];
      // Fan-out bookkeeping, shared by the read and the write views. A PARENT
      // that fanned out acted on no single row (each match got its own run); a
      // CHILD's reshaped output carries its own 1-based position.
      const fannedOut =
        typeof root?.fannedOut === "number" ? root.fannedOut : null;
      const childIndex = typeof root?.index === "number" ? root.index : null;
      const childTotal = typeof root?.total === "number" ? root.total : null;
      const isChildRun = root?.__fanOut === true && childIndex !== null;

      // A bottom append. A non-bottom append (position under_*) renders as an
      // insert below — the two used to be separate actions and keep separate
      // summaries. `?? "bottom"` covers pre-position append records too.
      if (
        root?.action === "append_row" &&
        (root.position ?? "bottom") === "bottom"
      ) {
        // Header-keyed row, in sheet-column order. The legacy raw-values path
        // emits none, so that falls back to the count alone.
        const appendedRow = (root.rowByHeader ?? {}) as Record<string, string>;
        const appendedColumns = Object.keys(appendedRow);
        const added =
          typeof root.appendedRows === "number" ? root.appendedRows : 1;

        const withSeparator = root.blankRowAbove === true;
        return (
          <div className="space-y-2">
            <SummaryMessage>
              {added === 1
                ? `Added 1 new row to the bottom of ${tab}.`
                : `Added ${added} new rows to the bottom of ${tab}.`}
              {withSeparator
                ? " A blank separator row was added directly above it."
                : ""}
            </SummaryMessage>
            {appendedColumns.length > 0 ? (
              <RowChangeGrid
                columns={appendedColumns}
                before={{}}
                after={appendedRow}
                singleRowLabel="Added"
              />
            ) : null}
          </div>
        );
      }

      if (root?.action === "find_rows") {
        const columns = Array.isArray(root.columns)
          ? (root.columns as string[])
          : [];
        const rows = Array.isArray(root.rows)
          ? (root.rows as Record<string, string>[])
          : [];
        const count =
          typeof root.matchCount === "number" ? root.matchCount : rows.length;
        // Which row THIS run went on to use: a child uses its own row; a
        // "first"-mode run uses row 1 — worth pointing out only when several
        // matched, since the rest were then ignored.
        const actedRowIndex =
          isChildRun || (fannedOut === null && count > 1) ? 0 : null;
        return (
          <div className="space-y-2">
            <SummaryMessage>
              {isChildRun && childTotal !== null
                ? `Run ${childIndex} of ${childTotal} — this run is handling row ${childIndex} of the ${childTotal} rows that matched.`
                : fannedOut !== null
                  ? fannedOut === 0
                    ? `No rows in ${tab} matched the filter. No runs were started, so every step after this one was skipped.`
                    : `${fannedOut} rows in ${tab} matched the filter. Started one run per row, so the steps after this one ran ${fannedOut} times — once for each row.`
                  : count === 0
                    ? `No rows in ${tab} matched the filter. Nothing was read.`
                    : count === 1
                      ? `1 row in ${tab} matched the filter.`
                      : `${count} rows in ${tab} matched the filter. This step is set to use only the first, so the other ${count - 1} were ignored.`}
            </SummaryMessage>
            <RowConditionsTable
              conditions={conditionRows}
              input={node.input}
              unmatched={count === 0}
            />
            {columns.length > 0 && rows.length > 0 ? (
              <RowsGrid
                columns={columns}
                rows={rows}
                actedRowIndex={actedRowIndex}
              />
            ) : null}
          </div>
        );
      }

      if (root?.action === "update_row") {
        const after = (root.rowByHeader ?? {}) as Record<string, string>;
        const before = (root.previousRow ?? {}) as Record<string, string>;
        // Nothing matched ⇒ nothing was written, and there is no row to show.
        const matched = root.matched === true;
        // Column order comes from the row itself (the executor keys it by the
        // sheet's header row, in sheet order).
        const columns = Object.keys({ ...before, ...after });
        const count = typeof root.matchCount === "number" ? root.matchCount : 0;

        return (
          <div className="space-y-2">
            <SummaryMessage>
              {!matched
                ? `No rows in ${tab} matched the filter, so nothing was changed. This step only updates rows that already exist — it never adds one.`
                : isChildRun && childTotal !== null
                  ? `Run ${childIndex} of ${childTotal} — this run is handling the row below, one of the ${childTotal} rows that were updated.`
                  : fannedOut !== null
                    ? `${fannedOut} rows in ${tab} matched the filter, and all ${fannedOut} were updated. Started one run per row, so the steps after this one ran ${fannedOut} times — once for each row.`
                    : count > 1
                      ? `${count} rows in ${tab} matched the filter, but this step is set to update only the first. 1 row was changed; the other ${count - 1} were left untouched.`
                      : `1 row in ${tab} matched the filter, and it was updated.`}
            </SummaryMessage>
            <RowConditionsTable
              conditions={conditionRows}
              input={node.input}
              unmatched={!matched}
            />
            {matched && columns.length > 0 ? (
              <RowChangeGrid
                columns={columns}
                before={before}
                after={after}
                // A fan-out child's reshaped output carries only the row it
                // handled, with no prior state to diff against.
                singleRowLabel={isChildRun ? "Updated" : null}
              />
            ) : null}
          </div>
        );
      }

      if (root?.action === "color_rows") {
        const columns = Array.isArray(root.columns)
          ? (root.columns as string[])
          : [];
        const rows = Array.isArray(root.rows)
          ? (root.rows as Record<string, string>[])
          : [];
        const rowIndexes = Array.isArray(root.rowIndexes)
          ? (root.rowIndexes as number[])
          : [];
        const colors = Array.isArray(root.colors)
          ? (root.colors as string[])
          : [];
        const count =
          typeof root.matchCount === "number" ? root.matchCount : rows.length;
        // How many DISTINCT rules actually fired — worth saying, because the
        // whole point of several rules is that different rows get different
        // colors.
        const distinctColors = new Set(colors).size;

        return (
          <div className="space-y-2">
            <SummaryMessage>
              {count === 0
                ? `No rows in ${tab} matched any color rule, so nothing was colored.`
                : count === 1
                  ? `1 row in ${tab} matched a color rule and was colored.`
                  : `${count} rows in ${tab} matched a color rule and were colored${
                      distinctColors > 1
                        ? `, in ${distinctColors} different colors`
                        : ""
                    }. A row matching more than one rule takes the first rule's color.`}
            </SummaryMessage>
            {/* No RowConditionsTable here: this action has N rule filters, and
                that table renders exactly one flat condition list — it cannot
                state which rule claimed which row without misleading. */}
            {columns.length > 0 && rows.length > 0 ? (
              <RowsGrid
                columns={columns}
                rows={rows}
                rowLabels={rowIndexes.map((n) => `Row ${n}`)}
                rowColors={colors}
              />
            ) : null}
          </div>
        );
      }

      // A non-bottom append (position under_*), or a historical run recorded
      // under the old `insert_row_adjacent` action before the two were merged.
      if (
        root?.action === "insert_row_adjacent" ||
        (root?.action === "append_row" &&
          (root.position ?? "bottom") !== "bottom")
      ) {
        // This path ALWAYS writes — there is no no-op outcome. What varies is
        // how many rows it wrote and where they went, so every line below states
        // both. The cases: nothing matched (one row starts a new group at the
        // bottom); one row went below the group; one row went below EACH match
        // (a fan-out parent); or this is one child of that fan-out.
        const addedRow = (root.rowByHeader ?? {}) as Record<string, string>;
        const anchorRow = (root.anchorRow ?? {}) as Record<string, string>;
        const count = typeof root.matchCount === "number" ? root.matchCount : 0;
        const joinedGroup = root.insertedUnderGroup === true;
        const rowNumber =
          typeof root.rowIndex === "number" ? root.rowIndex : null;
        // Present only in "below every matching row" mode, and only on the
        // PARENT run — a child's reshaped output carries just its own row.
        const addedRows = Array.isArray(root.insertedRows)
          ? (root.insertedRows as Record<string, string>[])
          : null;
        const addedRowNumbers = Array.isArray(root.insertedRowIndexes)
          ? (root.insertedRowIndexes as number[])
          : null;
        // The multi-row grid is for the fan-out PARENT only. A no-match run in
        // that same mode wrote exactly one row (a new group at the bottom), so
        // it renders like every other single-row insert.
        const perMatch = addedRows !== null && !isChildRun && joinedGroup;

        const at = rowNumber !== null ? ` It is now row ${rowNumber}.` : "";
        const summary = !joinedGroup
          ? // Nothing matched. Still a success — and in "per match" mode the
            // fan-out did NOT happen, which the user has to be told: they chose
            // "once per row", and the steps after this one ran exactly once.
            `No rows in ${tab} matched the filter, so there was no group to add to. One new row was added at the bottom of the tab, starting a group of its own.${at}${
              addedRows !== null
                ? " No rows matched, so nothing was fanned out — the steps after this one ran once."
                : ""
            }`
          : isChildRun && childTotal !== null
            ? `Run ${childIndex} of ${childTotal} — this run is handling the row below, one of the ${childTotal} rows this step added.`
            : fannedOut !== null
              ? // Fan-out parent: N matched, N rows added, N child runs.
                fannedOut === 1
                ? `1 row in ${tab} matched the filter, and a new row was added directly below it. Started one run for that row, so the steps after this one ran once.`
                : `${fannedOut} rows in ${tab} matched the filter, and a new row was added directly below each one. Started one run per added row, so the steps after this one ran ${fannedOut} times.`
              : count === 1
                ? `Added 1 row to ${tab}, directly below the row that matched.${at}`
                : `${count} rows in ${tab} matched the filter — they are the group. Added 1 row directly below the last of them, so it joins the bottom of that group.${at}`;

        // The grid shows exactly the rows THIS run wrote: all of them in "per
        // match" mode (labelled with the sheet row each landed on), otherwise
        // the single row — with the row it was placed under above it, which is
        // the one thing a lone "Added" row can't show.
        const columns = perMatch
          ? Object.keys(
              Object.assign({}, ...(addedRows as Record<string, string>[])),
            )
          : Object.keys({ ...anchorRow, ...addedRow });

        return (
          <div className="space-y-2">
            <SummaryMessage>{summary}</SummaryMessage>
            <RowConditionsTable
              conditions={conditionRows}
              input={node.input}
              unmatched={!joinedGroup}
              unmatchedLabel="No rows matched these conditions, so the new row started a group of its own:"
              // Not a failure — a row was still written.
              unmatchedTone="muted"
            />
            {columns.length === 0 ? null : perMatch ? (
              <RowsGrid
                columns={columns}
                rows={addedRows as Record<string, string>[]}
                rowLabels={addedRowNumbers?.map((n) => `Row ${n}`) ?? null}
              />
            ) : (
              <RowChangeGrid
                columns={columns}
                before={{}}
                after={addedRow}
                singleRowLabel="Added"
                // The anchor — absent when nothing matched, since then the row
                // was placed under nothing at all.
                contextRow={
                  joinedGroup && Object.keys(anchorRow).length > 0
                    ? { label: "Row above", cells: anchorRow }
                    : null
                }
              />
            )}
          </div>
        );
      }
    }

    const message = nodeSummaries[
      node.nodeType as keyof typeof nodeSummaries
    ]?.({
      output: getNodeOutputRoot(node.nodeType, node.output),
      config: config ?? {},
      resolve: (template) => renderReferences(template, node.input),
    });
    const fields = resolveFriendlyOutput(node.nodeType, node.output);

    if (fields === null && !message) return null; // undeclared → raw JSON
    if ((fields === null || fields.length === 0) && !message) {
      return (
        <StatusNote>
          Completed — this node produced no output fields.
        </StatusNote>
      );
    }
    return (
      <div className="space-y-2">
        {message ? <SummaryMessage>{message}</SummaryMessage> : null}
        {fields && fields.length > 0 ? <FieldTable rows={fields} /> : null}
      </div>
    );
  }, [
    isTrigger,
    node.status,
    node.nodeType,
    node.output,
    node.input,
    config,
    producers,
    runNodeTypes,
  ]);

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        {getStatusIcon(node.status)}
        <span className="text-sm font-medium">{node.nodeName}</span>
        <span className="text-xs text-muted-foreground">{node.nodeType}</span>
        <div className="ml-auto flex items-center gap-2">
          {node.durationMs != null ? (
            <span className="text-xs text-muted-foreground">
              {formatDuration(node.durationMs)}
            </span>
          ) : null}
          {!isSkipped ? (
            <ReplayFromNodeButton
              executionId={executionId}
              nodeId={node.nodeId}
            />
          ) : null}
        </div>
      </div>

      {node.error ? (
        <p className="mt-2 text-sm font-mono text-red-700">{node.error}</p>
      ) : null}

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="mt-2 h-7 px-2">
            {open ? "Hide data" : "Show input / output"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3">
          <DataSection
            label="Input"
            raw={node.input}
            friendly={inputFriendly}
          />
          <DataSection
            label="Output"
            raw={node.output}
            friendly={outputFriendly}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

// Suspense fallback for the execution detail route. Mirrors `ExecutionView`'s
// card — status-icon header, the 2-col metadata grid, and a short stack of
// node-row placeholders — so the real detail lands without a layout jump.
export const ExecutionDetailLoading = () => {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Skeleton className="size-5 rounded-full" />
          <div className="flex flex-col gap-y-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3.5 w-52" />
          </div>
          <Skeleton className="ml-auto h-9 w-24 rounded-md" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static placeholder grid
              key={index}
              className="flex flex-col gap-y-2"
            >
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
        <div className="mt-6 space-y-2">
          <Skeleton className="h-4 w-14" />
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static placeholder list
              key={index}
              className="h-14 w-full rounded-xl"
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

export const ExecutionView = ({ executionId }: { executionId: string }) => {
  const { data: execution } = useSuspenseExecution(executionId);
  const [showStackTrace, setShowStackTrace] = useState(false);
  const [showFinalOutput, setShowFinalOutput] = useState(false);

  const totalDurationMs = execution.completedAt
    ? new Date(execution.completedAt).getTime() -
      new Date(execution.startedAt).getTime()
    : null;

  // Map each context key to the node that wrote it, so a downstream node's input
  // can be labeled with its source node's name. A node's output diff is a single
  // namespaced key, so its first key is the context key it contributes.
  const producers = useMemo<Producer[]>(
    () =>
      execution.nodeExecutions.flatMap((n) => {
        if (!n.output || typeof n.output !== "object") return [];
        const contextKey = Object.keys(n.output)[0];
        if (!contextKey) return [];
        return [{ contextKey, nodeType: n.nodeType, label: n.nodeName }];
      }),
    [execution.nodeExecutions],
  );

  // Node types present in this run — lets the input view group "topLevel"
  // triggers (whose fields sit at the context root with no wrapping key).
  const runNodeTypes = useMemo(
    () => execution.nodeExecutions.map((n) => n.nodeType),
    [execution.nodeExecutions],
  );

  // Saved config per node id, so each row's input can show only the upstream
  // fields its config references.
  const configByNodeId = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const n of execution.workflow.nodes) {
      map.set(n.id, (n.data ?? {}) as Record<string, unknown>);
    }
    return map;
  }, [execution.workflow.nodes]);

  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex items-center gap-3">
          {getStatusIcon(execution.status)}
          <div>
            <CardTitle>{formatStatus(execution.status)}</CardTitle>
            <CardDescription>
              Execution for {execution.workflow.name}
            </CardDescription>
          </div>
          <div className="ml-auto">
            <RerunButton executionId={execution.id} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Workflow
            </p>
            <Link
              prefetch
              className="text-sm hover:underline text-primary"
              href={`/workflows/${execution.workflowId}`}
            >
              {execution.workflow.name}
            </Link>
          </div>

          <div>
            <p className="text-sm font-medium text-muted-foreground">Status</p>
            <p className="text-sm">{formatStatus(execution.status)}</p>
          </div>

          <div>
            <p className="text-sm font-medium text-muted-foreground">Started</p>
            <p className="text-sm">
              {formatDistanceToNow(execution.startedAt, { addSuffix: true })}
            </p>
          </div>

          {execution.completedAt ? (
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Completed
              </p>
              <p className="text-sm">
                {formatDistanceToNow(execution.completedAt, {
                  addSuffix: true,
                })}
              </p>
            </div>
          ) : null}

          {totalDurationMs !== null ? (
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Duration
              </p>
              <p className="text-sm">{formatDuration(totalDurationMs)}</p>
            </div>
          ) : null}

          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Event ID
            </p>
            <p className="text-sm">{execution.inngestEventId}</p>
          </div>
        </div>

        {execution.nodeExecutions.length > 0 && (
          <div className="mt-6 space-y-2">
            <p className="text-sm font-medium">Nodes</p>
            {execution.nodeExecutions.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                executionId={execution.id}
                producers={producers}
                runNodeTypes={runNodeTypes}
                config={configByNodeId.get(node.nodeId)}
              />
            ))}
          </div>
        )}

        {execution.error && (
          <div className="mt-6 p-4 bg-red-50 rounded-md space-y-3">
            <div>
              <p className="text-sm font-medium text-red-900 mb-2">Error</p>
              <p className="text-sm text-red-800 font-mono">
                {execution.error}
              </p>
            </div>

            {execution.errorStack && (
              <Collapsible
                open={showStackTrace}
                onOpenChange={setShowStackTrace}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-900 hover:bg-red-100"
                  >
                    {showStackTrace ? "Hide stack trace" : "Show stack trace"}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="text-xs font-mono text-red-800 overflow-auto mt-2 p-2 bg-red-100">
                    {execution.errorStack}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}

        {execution.output != null && (
          <div className="mt-6 p-4 bg-muted rounded-md">
            <Collapsible
              open={showFinalOutput}
              onOpenChange={setShowFinalOutput}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Final output</p>
                <div className="flex items-center gap-1">
                  <CopyJsonButton value={execution.output} />
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 px-2">
                      {showFinalOutput ? "Hide data" : "Show data"}
                    </Button>
                  </CollapsibleTrigger>
                </div>
              </div>
              <CollapsibleContent className="mt-2">
                <pre className="text-xs font-mono overflow-auto">
                  {JSON.stringify(execution.output, null, 2)}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
