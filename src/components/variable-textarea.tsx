"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { VariablePicker } from "@/components/variable-picker";
import { focusAfterInsert, insertAtCursor } from "@/lib/insert-at-cursor";
import { cn } from "@/lib/utils";

export type VariableTextareaProps = React.ComponentProps<typeof Textarea> & {
  currentNodeId: string;
  workflowId?: string;
};

export const VariableTextarea = React.forwardRef<
  HTMLTextAreaElement,
  VariableTextareaProps
>(
  (
    {
      className,
      currentNodeId,
      workflowId,
      value,
      onChange,
      disabled,
      ...rest
    },
    ref,
  ) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRefs = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    };

    const strValue = value === undefined || value === null ? "" : String(value);

    const handleVariableSelect = (variablePath: string) => {
      const el = innerRef.current;
      const start = el?.selectionStart ?? strValue.length;
      const newVal = insertAtCursor(el, strValue, variablePath);
      const synthetic = {
        target: { value: newVal, name: rest.name },
      } as React.ChangeEvent<HTMLTextAreaElement>;
      onChange?.(synthetic);
      if (el && el.selectionStart != null) {
        focusAfterInsert(el, start + variablePath.length);
      }
    };

    return (
      <div className="relative w-full">
        <Textarea
          ref={setRefs}
          // Reserve space at the bottom so the picker button (bottom-right)
          // never sits over typed text.
          className={cn("pb-10", className)}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...rest}
        />
        <div className="absolute bottom-2 right-2 z-10">
          <VariablePicker
            currentNodeId={currentNodeId}
            workflowId={workflowId}
            onSelect={handleVariableSelect}
            disabled={disabled}
          />
        </div>
      </div>
    );
  },
);

VariableTextarea.displayName = "VariableTextarea";
