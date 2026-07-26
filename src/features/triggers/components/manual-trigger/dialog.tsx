"use client";

import { EditableNodeTitle } from "@/components/editable-node-title";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentNodeId: string;
}

export const ManualTriggerDialog = ({
  open,
  onOpenChange,
  currentNodeId,
}: Props) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Configure settings for the manual trigger node.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="text-sm text-muted-foreground">
            Used to manually execute a workflow, no configuration available.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};
