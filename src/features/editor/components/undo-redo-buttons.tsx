"use client";

import { useAtomValue } from "jotai";
import { Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { historyControlsAtom } from "../store/atoms";

// Canvas undo/redo. Reads the controls published by <HistoryController> so the
// buttons and (next) the keyboard shortcuts drive one shared engine. Each button
// disables when its stack is empty.
export const UndoRedoButtons = () => {
  const controls = useAtomValue(historyControlsAtom);

  return (
    <div className="flex gap-1">
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="bg-background"
        aria-label="Undo"
        title="Undo"
        disabled={!controls?.canUndo}
        onClick={() => controls?.undo()}
      >
        <Undo2Icon />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="bg-background"
        aria-label="Redo"
        title="Redo"
        disabled={!controls?.canRedo}
        onClick={() => controls?.redo()}
      >
        <Redo2Icon />
      </Button>
    </div>
  );
};
