"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2Icon,
  ClockIcon,
  Loader2Icon,
  RotateCwIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { ExecutionStatus } from "@/generated/prisma";
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

const JsonBlock = ({ label, value }: { label: string; value: unknown }) => (
  <div>
    <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
    <pre className="text-xs font-mono overflow-auto rounded bg-muted p-2 max-h-64">
      {JSON.stringify(value, null, 2)}
    </pre>
  </div>
);

type NodeExecutionRow = {
  id: string;
  nodeName: string;
  nodeType: string;
  status: string;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

const NodeRow = ({ node }: { node: NodeExecutionRow }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        {getStatusIcon(node.status)}
        <span className="text-sm font-medium">{node.nodeName}</span>
        <span className="text-xs text-muted-foreground">{node.nodeType}</span>
        {node.durationMs != null ? (
          <span className="ml-auto text-xs text-muted-foreground">
            ~{node.durationMs}ms
          </span>
        ) : null}
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
          <JsonBlock label="Input" value={node.input} />
          <JsonBlock label="Output" value={node.output} />
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
              <NodeRow key={node.id} node={node} />
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
