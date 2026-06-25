"use client";

import { Card, CardContent } from "@/components/ui/card";
import { useExecutionStats } from "../hooks/use-execution-stats";

const Stat = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) => (
  <Card className="shadow-none">
    <CardContent className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </CardContent>
  </Card>
);

const formatDuration = (seconds: number | null) => {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
};

const prettyNodeType = (type: string) =>
  type
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export const ExecutionStats = () => {
  const { data, isPending } = useExecutionStats(30);

  if (isPending) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {["runs", "rate", "duration", "running"].map((key) => (
          <Card key={key} className="shadow-none">
            <CardContent className="p-4">
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
              <div className="mt-2 h-7 w-12 animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!data || data.total === 0) return null;

  const successRate =
    data.successRate == null ? "—" : `${Math.round(data.successRate * 100)}%`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Runs (30d)" value={String(data.total)} />
        <Stat
          label="Success rate"
          value={successRate}
          hint={`${data.success} ok · ${data.failed} failed`}
        />
        <Stat
          label="Avg duration"
          value={formatDuration(data.avgDurationSeconds)}
          hint="successful runs"
        />
        <Stat label="Running" value={String(data.running)} />
      </div>

      {data.topFailingNodes.length > 0 ? (
        <Card className="shadow-none">
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground">
              Top failing nodes (30d)
            </p>
            <ul className="mt-2 space-y-1">
              {data.topFailingNodes.map((node) => (
                <li
                  key={node.nodeType}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{prettyNodeType(node.nodeType)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {node.count}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
};
