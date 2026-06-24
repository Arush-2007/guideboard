"use client";

import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { SaveIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Input } from "@/components/ui/input";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSuspenseWorkflow, useUpdateWorkflow, useUpdateWorkflowName } from "@/features/workflows/hooks/use-workflows";
import { useAtomValue } from "jotai";
import { editorAtom } from "../store/atoms";

export const EditorSaveButton = ({ workflowId }: { workflowId: string }) => {
  const editor = useAtomValue(editorAtom);
  const saveWorkflow = useUpdateWorkflow();

  const handleSave = () => {
    if (!editor) {
      return;
    }

    const nodes = editor.getNodes();
    const edges = editor.getEdges();

    saveWorkflow.mutate({
      id: workflowId,
      nodes,
      edges,
    });
  }

  return (
    <div className="ml-auto">
      <Button size="sm" onClick={handleSave} disabled={saveWorkflow.isPending} className="h-[2.025rem] px-4 text-[1.09rem]">
        <SaveIcon className="size-5" />
        Save
      </Button>
    </div>
  )
};

export const EditorNameInput = ({ workflowId }: { workflowId: string }) => {
  const { data: workflow } = useSuspenseWorkflow(workflowId);
  const updateWorkflow = useUpdateWorkflowName();

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(workflow.name);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (workflow.name) {
      setName(workflow.name);
    }
  }, [workflow.name]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (name === workflow.name) {
      setIsEditing(false);
      return;
    }

    try {
      await updateWorkflow.mutateAsync({
        id: workflowId,
        name,
      });
    } catch {
      setName(workflow.name);
    } finally {
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      setName(workflow.name);
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <Input
        disabled={updateWorkflow.isPending}
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className="h-9 w-auto min-w-[100px] px-2 text-[1.09rem]"
      />
    )
  }

  return (
    <BreadcrumbItem onClick={() => setIsEditing(true)} className="cursor-pointer hover:text-foreground transition-colors">
      {workflow.name}
    </BreadcrumbItem>
  )
};

export const EditorBreadcrumbs = ({ workflowId }: { workflowId: string }) => {
  return (
    <Breadcrumb>
      <BreadcrumbList className="text-[1.09rem]">
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link prefetch href="/workflows">
              Workflows
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <EditorNameInput workflowId={workflowId} />
      </BreadcrumbList>
    </Breadcrumb>
  )
};

export const EditorHeader = ({ workflowId }: { workflowId: string }) => {
  return (
    <header className="sticky top-0 z-20 flex h-[2.97675rem] shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger />
      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
        <div className="pointer-events-auto">
          <EditorBreadcrumbs workflowId={workflowId} />
        </div>
      </div>
      <EditorSaveButton workflowId={workflowId} />
    </header>
  );
};
