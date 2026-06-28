"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2Icon,
  ClockIcon,
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
import { ExecutionStatus, NodeExecutionStatus } from "@/generated/prisma";
import {
  type Producer,
  resolveFriendlyInput,
  resolveFriendlyOutput,
} from "@/lib/friendly-output";
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
        {hasFriendly ? (
          <div className="flex items-center gap-1">
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
          </div>
        ) : null}
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
}: {
  node: NodeExecutionRow;
  executionId: string;
  producers: Producer[];
  runNodeTypes: string[];
}) => {
  const [open, setOpen] = useState(false);
  const isSkipped = node.status === NodeExecutionStatus.SKIPPED;

  // Input: the context this node received, grouped by the upstream node that
  // produced each part — the same curated fields the variable picker exposes.
  const inputFriendly = useMemo<ReactNode | null>(() => {
    const sources = resolveFriendlyInput(node.input, producers, runNodeTypes);
    if (sources === null) return null;
    if (sources.length === 0) return <EmptyFriendly />;
    return (
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
  }, [node.input, producers, runNodeTypes]);

  // Output: this node's own produced fields.
  const outputFriendly = useMemo<ReactNode | null>(() => {
    const fields = resolveFriendlyOutput(node.nodeType, node.output);
    if (fields === null) return null;
    if (fields.length === 0) return <EmptyFriendly />;
    return <FieldTable rows={fields} />;
  }, [node.nodeType, node.output]);

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        {getStatusIcon(node.status)}
        <span className="text-sm font-medium">{node.nodeName}</span>
        <span className="text-xs text-muted-foreground">{node.nodeType}</span>
        <div className="ml-auto flex items-center gap-2">
          {node.durationMs != null ? (
            <span className="text-xs text-muted-foreground">
              ~{node.durationMs}ms
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

  const duration = execution.completedAt
    ? Math.round(
        (new Date(execution.completedAt).getTime() -
          new Date(execution.startedAt).getTime()) /
          1000,
      )
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

          {duration !== null ? (
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Duration
              </p>
              <p className="text-sm">{duration}s</p>
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

        {execution.output && (
          <div className="mt-6 p-4 bg-muted rounded-md">
            <p className="text-sm font-medium mb-2">Final output</p>
            <pre className="text-xs font-mono overflow-auto">
              {JSON.stringify(execution.output, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
