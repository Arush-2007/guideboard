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
import { useSuspenseExecution } from "@/features/executions/hooks/use-executions";
import { formatDuration } from "@/features/executions/lib/format-duration";
import {
  COMPARE_OPERATOR_LABELS,
  type CompareOperator,
} from "@/features/executions/lib/compare";
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
  cfg: { field?: unknown; operator?: unknown; value?: unknown },
  input: unknown,
  producers: Producer[],
  runNodeTypes: string[],
): { label: string; value: unknown }[] => {
  const operator = typeof cfg.operator === "string" ? cfg.operator : "";
  const field = describeConfigValue(cfg.field, input, producers, runNodeTypes);
  const rows = [
    { label: field.label, value: field.value },
    {
      label: "Operator",
      value: COMPARE_OPERATOR_LABELS[operator as CompareOperator] ?? operator,
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
