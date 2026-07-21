"use client";

import { formatDistanceToNow } from "date-fns";
import {
  CopyIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  EmptyView,
  EntityContainer,
  EntityItem,
  EntityList,
  EntityListSkeleton,
  EntityPagination,
  EntitySearch,
} from "@/components/entity-components";
import { Badge } from "@/components/ui/badge";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Workflow } from "@/generated/prisma";
import { useDismissedNotice } from "@/hooks/use-dismissed-notice";
import { useEntitySearch } from "@/hooks/use-entity-search";
import { useUpgradeModal } from "@/hooks/use-upgrade-modal";
import {
  useCreateWorkflow,
  useDuplicateWorkflow,
  useGenerateWorkflowFromPrompt,
  useRemoveWorkflow,
  useSuspenseWorkflows,
} from "../hooks/use-workflows";
import { useWorkflowsParams } from "../hooks/use-workflows-params";

export const WorkflowsSearch = () => {
  const [params, setParams] = useWorkflowsParams();
  const { searchValue, onSearchChange } = useEntitySearch({
    params,
    setParams,
  });

  return (
    <EntitySearch
      value={searchValue}
      onChange={onSearchChange}
      placeholder="Search workflows"
    />
  );
};

export const WorkflowsList = () => {
  const workflows = useSuspenseWorkflows();
  const duplicateWorkflow = useDuplicateWorkflow();
  const { dismissed, dismiss } = useDismissedNotice(COPY_NOTICE_KEY);

  // The copy notice is a single global preference and at most one dialog is
  // ever open, so both live here rather than in each row: per-row copies of
  // `dismissed` would drift (ticking "don't show again" on one row left every
  // other row still showing it), and each row would mount its own dialog.
  const [copyTarget, setCopyTarget] = useState<Workflow | null>(null);

  const runCopy = (workflow: Workflow) => {
    duplicateWorkflow.mutate(
      { id: workflow.id },
      { onSuccess: () => setCopyTarget(null) },
    );
  };

  const handleCopy = (workflow: Workflow) => {
    if (dismissed) {
      runCopy(workflow);
      return;
    }
    setCopyTarget(workflow);
  };

  return (
    <>
      <CopyWorkflowNoticeDialog
        workflow={copyTarget}
        onOpenChange={(open) => {
          if (!open) setCopyTarget(null);
        }}
        isCopying={duplicateWorkflow.isPending}
        onConfirm={(dontShowAgain) => {
          if (dontShowAgain) dismiss();
          if (copyTarget) runCopy(copyTarget);
        }}
      />
      <EntityList
        items={workflows.data.items}
        getKey={(workflow) => workflow.id}
        renderItem={(workflow) => (
          <WorkflowItem
            data={workflow}
            onCopy={handleCopy}
            isCopying={duplicateWorkflow.isPending}
          />
        )}
        emptyView={<WorkflowsEmpty />}
      />
    </>
  );
};

export const CreateWorkflowDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const createWorkflow = useCreateWorkflow();
  const { handleError, modal } = useUpgradeModal();
  const [name, setName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    createWorkflow.mutate(
      { name: trimmed },
      {
        onSuccess: (data) => {
          setName("");
          onOpenChange(false);
          router.push(`/workflows/${data.id}`);
        },
        onError: (error) => {
          handleError(error);
        },
      },
    );
  };

  return (
    <>
      {modal}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <WorkflowIcon className="size-4" />
              Name your workflow
            </DialogTitle>
            <DialogDescription>
              Give your new workflow a name to get started.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 pt-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lead capture to Slack"
              className="h-10 rounded-xl border-border/70 bg-background/80"
              disabled={createWorkflow.isPending}
              autoFocus
            />
            <Button
              type="submit"
              size="sm"
              className="h-10 self-end rounded-full px-5"
              disabled={createWorkflow.isPending || !name.trim()}
            >
              {createWorkflow.isPending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <PlusIcon className="size-4" />
              )}
              Create
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};

// Page-level toolbar: the "New workflow" / "Generate with AI" actions on the
// left and the workflows search box on the right. Rendered in the container's
// search slot since the standalone page header card was removed.
export const WorkflowsToolbar = () => {
  const router = useRouter();
  const [aiOpen, setAiOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const generate = useGenerateWorkflowFromPrompt();

  const handleGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;

    generate.mutate(
      { prompt: trimmed },
      {
        onSuccess: (data) => {
          setPrompt("");
          setAiOpen(false);
          router.push(`/workflows/${data.workflowId}`);
        },
        onError: (error) => {
          toast.error(error.message);
        },
      },
    );
  };

  return (
    <>
      <CreateWorkflowDialog open={createOpen} onOpenChange={setCreateOpen} />
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SparklesIcon className="size-4" />
              Generate with AI
            </DialogTitle>
            <DialogDescription>
              Describe your automation and AI will build the workflow for you.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleGenerate} className="flex flex-col gap-3 pt-2">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. When someone comments on my YouTube video, reply with AI"
              className="h-10 rounded-xl border-border/70 bg-background/80"
              disabled={generate.isPending}
              autoFocus
            />
            <Button
              type="submit"
              size="sm"
              className="h-10 self-end rounded-full px-5"
              disabled={generate.isPending || !prompt.trim()}
            >
              {generate.isPending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <SparklesIcon className="size-4" />
              )}
              Generate
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="rounded-full px-5"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="size-4" />
            New workflow
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full px-5"
            onClick={() => setAiOpen(true)}
          >
            <SparklesIcon className="size-4" />
            Generate with AI
          </Button>
        </div>
        <WorkflowsSearch />
      </div>
    </>
  );
};

export const WorkflowsPagination = () => {
  const workflows = useSuspenseWorkflows();
  const [params, setParams] = useWorkflowsParams();

  // Nothing to paginate through with a single page — hide the bar entirely.
  if (workflows.data.totalPages <= 1) {
    return null;
  }

  return (
    <EntityPagination
      disabled={workflows.isFetching}
      totalPages={workflows.data.totalPages}
      page={workflows.data.page}
      onPageChange={(page) => setParams({ ...params, page })}
    />
  );
};

export const WorkflowsContainer = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  return (
    <EntityContainer
      search={<WorkflowsToolbar />}
      pagination={<WorkflowsPagination />}
    >
      {children}
    </EntityContainer>
  );
};

export const WorkflowsLoading = () => {
  return <EntityListSkeleton />;
};

export const WorkflowsEmpty = () => {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <CreateWorkflowDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EmptyView
        onNew={() => setCreateOpen(true)}
        message="You haven't created any workflows yet. Get started by creating your first workflow"
      />
    </>
  );
};

// Shown the first time a user copies a workflow, because the copy's triggers
// are deliberately dormant (see `duplicateWorkflow`) — a surprise worth
// explaining once, and only once.
const COPY_NOTICE_KEY = "workflow_copy";

const CopyWorkflowNoticeDialog = ({
  workflow,
  onOpenChange,
  isCopying,
  onConfirm,
}: {
  /** The workflow about to be copied, or null when no copy is pending. */
  workflow: Workflow | null;
  onOpenChange: (open: boolean) => void;
  isCopying: boolean;
  onConfirm: (dontShowAgain: boolean) => void;
}) => {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const checkboxId = useId();
  const workflowName = workflow?.name ?? "";

  return (
    <Dialog open={workflow !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CopyIcon className="size-4" />
            About copying a workflow
          </DialogTitle>
          <DialogDescription>
            How the copy of &ldquo;{workflowName}&rdquo; will behave.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-1 text-sm text-muted-foreground">
          <p>
            The copy gets every node, connection and setting from the original.
            It&apos;s named after it and numbered &mdash;{" "}
            <span className="font-medium text-foreground">
              {workflowName}.2
            </span>
            , then <span className="font-medium text-foreground">.3</span>, and
            so on for each further copy.
          </p>
          <p>
            <span className="font-medium text-foreground">
              The copy starts inactive.
            </span>{" "}
            Its triggers &mdash; Gmail, Google Sheets, Schedule and webhooks
            &mdash; won&apos;t run until you open the copy and save it. That way
            copying a live automation doesn&apos;t silently start running it
            twice.
          </p>
          <p>
            So the copy opens with{" "}
            <span className="font-medium text-foreground">Save</span> ready
            rather than &ldquo;Saved&rdquo;, and it&apos;s marked{" "}
            <span className="font-medium text-foreground">Not saved yet</span>{" "}
            in this list, until you save it once. A webhook trigger gets its own
            new URL on that save; it never shares the original&apos;s.
          </p>
        </div>
        <DialogFooter className="pt-2 sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(checked === true)}
            />
            <Label
              htmlFor={checkboxId}
              className="cursor-pointer text-sm font-normal text-muted-foreground"
            >
              Don&apos;t show this again
            </Label>
          </div>
          <Button
            size="sm"
            className="rounded-full px-5"
            disabled={isCopying}
            onClick={() => onConfirm(dontShowAgain)}
          >
            {isCopying ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            Copy workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const WorkflowItem = ({
  data,
  onCopy,
  isCopying,
}: {
  data: Workflow;
  onCopy: (workflow: Workflow) => void;
  isCopying: boolean;
}) => {
  const removeWorkflow = useRemoveWorkflow();

  const handleRemove = () => {
    removeWorkflow.mutate({ id: data.id });
  };

  return (
    <EntityItem
      href={`/workflows/${data.id}`}
      title={data.name}
      titleBadge={
        data.pendingFirstSave ? (
          // A copy is inert until its first save provisions the poll rows —
          // say so here rather than letting it sit in the list looking live.
          <Badge variant="outline" className="shrink-0 text-xs font-normal">
            Not saved yet
          </Badge>
        ) : null
      }
      subtitle={
        <>
          Updated {formatDistanceToNow(data.updatedAt, { addSuffix: true })}{" "}
          &bull; Created{" "}
          {formatDistanceToNow(data.createdAt, { addSuffix: true })}
        </>
      }
      image={
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
          <WorkflowIcon className="size-5 text-muted-foreground" />
        </div>
      }
      menuItems={
        <DropdownMenuItem onClick={() => onCopy(data)} disabled={isCopying}>
          <CopyIcon className="size-4" />
          Copy
        </DropdownMenuItem>
      }
      onRemove={handleRemove}
      isRemoving={removeWorkflow.isPending}
    />
  );
};
