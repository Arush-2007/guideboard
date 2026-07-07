"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Loader2Icon,
  RedoIcon,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTRPC } from "@/trpc/client";

/**
 * On-canvas failure detail for a node whose latest run FAILED. A red corner badge
 * (bottom-right, clear of NeedsConfigBadge at top-right and the mid-height
 * handles) opens a popover with the real error message plus "View execution" and
 * "Replay from here" — so a failure is understood without leaving the editor.
 *
 * Only mounted by the base nodes when the live status is "error" (see
 * base-execution-node / base-trigger-node), and the failure query is `enabled`
 * only while the popover is open, so N failed nodes never fire N requests. The
 * error text and executionId come from `executions.getLatestNodeFailure` (option
 * b: on-demand fetch — the realtime status payload carries no error, and FAILED
 * is published per-executor, not centrally, so widening it isn't viable).
 */
export const NodeFailureBadge = ({ nodeId }: { nodeId: string }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery(
    trpc.executions.getLatestNodeFailure.queryOptions(
      { nodeId },
      // Fetch only while open, and treat cached data as immediately stale so
      // re-opening after a re-run/replay reflects the latest failure (and its
      // executionId), never an earlier cached one. It's a single-row lookup
      // fired on a user click, so refetch-on-open is cheap.
      { enabled: open, staleTime: 0 },
    ),
  );

  const replay = useMutation(
    trpc.executions.replayFromNode.mutationOptions({
      onSuccess: () => {
        toast.success("Replay started from this node");
        queryClient.invalidateQueries(trpc.executions.getMany.queryOptions({}));
        setOpen(false);
      },
      onError: (error) => {
        toast.error(`Failed to replay: ${error.message}`);
      },
    }),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* nodrag/stopPropagation so clicking the badge opens the popover
            instead of starting a canvas drag or toggling node selection. */}
        <button
          type="button"
          title="This node failed — view error"
          aria-label="This node failed — view error"
          className="nodrag absolute -bottom-2 -right-2 z-10 cursor-pointer rounded-full drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.35)]"
          onClick={(e) => e.stopPropagation()}
        >
          <CircleAlert
            className="size-[18px] fill-red-500 text-white"
            strokeWidth={2.25}
          />
        </button>
      </PopoverTrigger>
      {/* Portaled to document.body (outside the React Flow pane), so it needs
          no nodrag/stopPropagation — canvas handlers never see these events. */}
      <PopoverContent align="end" className="w-80 space-y-3 p-3">
        <div className="flex items-center gap-2">
          <CircleAlert className="size-4 text-red-600" />
          <p className="text-sm font-medium">Node failed</p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading error…
          </div>
        ) : data ? (
          <>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-red-50 p-2 text-xs font-mono text-red-800">
              {data.error ??
                "This node failed, but no error message was recorded."}
            </pre>
            <div className="flex items-center justify-between gap-2">
              <Button asChild variant="outline" size="sm" className="h-7 px-2">
                <Link href={`/executions/${data.executionId}`}>
                  <SquareArrowOutUpRight className="size-3.5" />
                  View execution
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                disabled={replay.isPending}
                onClick={() =>
                  replay.mutate({ executionId: data.executionId, nodeId })
                }
              >
                <RedoIcon className="size-3.5" />
                {replay.isPending ? "Starting…" : "Replay from here"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No failure details were recorded for this node.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
};
