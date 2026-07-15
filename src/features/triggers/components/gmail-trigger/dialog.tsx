"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const GmailTriggerDialog = ({ open, onOpenChange }: Props) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Gmail Trigger</DialogTitle>
          <DialogDescription>
            This trigger polls your connected Gmail account every 5 minutes for
            new unread emails. It captures sender, subject, snippet, then marks
            each processed email as read.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
};
