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

export const GmailTriggerDialog = ({
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
            This trigger polls your connected Gmail account on the deployment's
            poll interval for new unread emails. It captures sender, subject,
            snippet, then marks each processed email as read.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
};
