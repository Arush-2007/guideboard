"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAGINATION } from "@/config/constants";
import { ExecutionStatus } from "@/generated/prisma";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";
import { useExecutionsParams } from "../hooks/use-executions-params";

const ALL_STATUSES = "ALL";
const ALL_WORKFLOWS = "all";

const STATUS_ITEMS = [
  { value: ALL_STATUSES, label: "All" },
  { value: ExecutionStatus.RUNNING, label: "Running" },
  { value: ExecutionStatus.SUCCESS, label: "Success" },
  { value: ExecutionStatus.FAILED, label: "Failed" },
] as const;

/**
 * Status + workflow filters for the executions list. State lives entirely in the
 * URL (via useExecutionsParams), so it's reload-safe and the server prefetch
 * renders the filtered list with no client flash. Every change resets to page 1.
 *
 * Styled as a toolbar band to match the page's header/pagination bands: pill
 * chips (active = filled, inactive = muted) on the left, workflow select right.
 */
export const ExecutionsFilters = () => {
  const trpc = useTRPC();
  const [params, setParams] = useExecutionsParams();

  // The full workflow list for the dropdown. Non-suspense so the filter bar
  // never blocks the page; capped at MAX_PAGE_SIZE (plenty for the picker).
  const { data } = useQuery(
    trpc.workflows.getMany.queryOptions({ pageSize: PAGINATION.MAX_PAGE_SIZE }),
  );
  const workflows = data?.items ?? [];
  const activeStatus = params.status ?? ALL_STATUSES;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-3xl border border-border/70 bg-card/85 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_ITEMS.map((item) => {
          const active = activeStatus === item.value;
          return (
            <Button
              key={item.value}
              type="button"
              size="sm"
              variant={active ? "default" : "ghost"}
              className={cn(
                "h-9 rounded-full px-4",
                !active && "text-muted-foreground",
              )}
              onClick={() =>
                setParams({
                  status: item.value === ALL_STATUSES ? null : item.value,
                  page: 1,
                })
              }
            >
              {item.label}
            </Button>
          );
        })}
      </div>

      <Select
        value={params.workflowId || ALL_WORKFLOWS}
        onValueChange={(next) =>
          setParams({
            workflowId: next === ALL_WORKFLOWS ? "" : next,
            page: 1,
          })
        }
      >
        <SelectTrigger
          size="sm"
          className="ml-auto h-9 w-[200px] rounded-full border-border/80 bg-card shadow-none"
        >
          <SelectValue placeholder="All workflows" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_WORKFLOWS}>All workflows</SelectItem>
          {workflows.map((workflow) => (
            <SelectItem key={workflow.id} value={workflow.id}>
              {workflow.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
