"use client";

import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2Icon,
  ClockIcon,
  Loader2Icon,
  RotateCwIcon,
  SplitIcon,
  XCircleIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  EmptyView,
  EntityContainer,
  EntityHeader,
  EntityItem,
  EntityList,
  EntityListSkeleton,
  EntityPagination,
} from "@/components/entity-components";
import { Badge } from "@/components/ui/badge";
import type { Execution } from "@/generated/prisma";
import { ExecutionStatus } from "@/generated/prisma";
import { parseFanOutItemIndex } from "@/inngest/fan-out";
import { useSuspenseExecutions } from "../hooks/use-executions";
import { useExecutionsParams } from "../hooks/use-executions-params";

export const ExecutionsList = () => {
  // The list owns live polling for the page; pagination just reads the cache.
  const executions = useSuspenseExecutions({ live: true });

  return (
    <EntityList
      items={executions.data.items}
      getKey={(execution) => execution.id}
      renderItem={(execution) => <ExecutionItem data={execution} />}
      emptyView={<ExecutionsEmpty />}
    />
  );
};

export const ExecutionsHeader = () => {
  return (
    <EntityHeader
      title="Executions"
      description="View your workflow execution history"
    />
  );
};

export const ExecutionsPagination = () => {
  const executions = useSuspenseExecutions();
  const [params, setParams] = useExecutionsParams();

  return (
    <EntityPagination
      disabled={executions.isFetching}
      totalPages={executions.data.totalPages}
      page={executions.data.page}
      onPageChange={(page) => setParams({ ...params, page })}
    />
  );
};

export const ExecutionsContainer = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  return (
    <EntityContainer
      header={<ExecutionsHeader />}
      pagination={<ExecutionsPagination />}
    >
      {children}
    </EntityContainer>
  );
};

export const ExecutionsLoading = () => {
  return <EntityListSkeleton />;
};

export const ExecutionsEmpty = () => {
  return (
    <EmptyView message="You haven't created any executions yet. Get started by running your first workflow" />
  );
};

const getStatusIcon = (status: ExecutionStatus) => {
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

const formatStatus = (status: ExecutionStatus) => {
  return status.charAt(0) + status.slice(1).toLowerCase();
};

/**
 * A fan-out child's idempotency key is `fanout:{parentExecId}:{nodeId}:{i}`
 * (cuids carry no colons, so a plain split is unambiguous); `i` is the 0-based
 * item index. Returns the 1-based item number, or null for anything else.
 *
 * Format owner: `fanOutItemIdempotencyKey` in src/inngest/fan-out.ts — keep the
 * two in sync (the parser lives here, not there, because that module reaches
 * Buffer/engine code this client bundle must not pull in).
 */
/** The 1-based item number shown on the badge, or null for a non-fan-out run. */
const fanOutItemNumber = (idempotencyKey: string | null): number | null => {
  const index = parseFanOutItemIndex(idempotencyKey);
  return index === null ? null : index + 1;
};

/**
 * Lineage badge for runs spawned by another run (`replayOfId`): a fan-out
 * child ("Row N of run #abc123") or a replay-from-node run ("Replay of
 * #abc123"). Clicking it opens the PARENT run — the card itself is a link to
 * this run, so the badge stops propagation and navigates imperatively (a
 * nested <a> would be invalid HTML).
 */
const LineageBadge = ({ data }: { data: Execution }) => {
  const router = useRouter();
  if (!data.replayOfId) return null;

  const parentId = data.replayOfId;
  const shortId = parentId.slice(-6);
  const itemNumber = fanOutItemNumber(data.idempotencyKey);

  return (
    <Badge asChild variant="secondary" className="hover:bg-secondary/70">
      <button
        type="button"
        title="Open the parent run"
        className="cursor-pointer"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          router.push(`/executions/${parentId}`);
        }}
      >
        {itemNumber !== null ? (
          <>
            <SplitIcon />
            Row {itemNumber} of run #{shortId}
          </>
        ) : (
          <>
            <RotateCwIcon />
            Replay of #{shortId}
          </>
        )}
      </button>
    </Badge>
  );
};

export const ExecutionItem = ({
  data,
}: {
  data: Execution & {
    workflow: {
      id: string;
      name: string;
    };
  };
}) => {
  const duration = data.completedAt
    ? Math.round(
        (new Date(data.completedAt).getTime() -
          new Date(data.startedAt).getTime()) /
          1000,
      )
    : null;

  const subtitle = (
    <>
      {data.workflow.name} &bull; Started{" "}
      {formatDistanceToNow(data.startedAt, { addSuffix: true })}
      {duration !== null && <> &bull; Took {duration}s </>}
    </>
  );

  return (
    <EntityItem
      href={`/executions/${data.id}`}
      title={formatStatus(data.status)}
      titleBadge={<LineageBadge data={data} />}
      subtitle={subtitle}
      image={
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
          {getStatusIcon(data.status)}
        </div>
      }
    />
  );
};
