"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { VariablePicker } from "@/components/variable-picker";
import { cn } from "@/lib/utils";
import { focusAfterInsert, insertAtCursor } from "@/lib/insert-at-cursor";

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
      <div className="w-full space-y-1">
        <div className="flex justify-end">
          <VariablePicker
            currentNodeId={currentNodeId}
            workflowId={workflowId}
            onSelect={handleVariableSelect}
            disabled={disabled}
          />
        </div>
        <Textarea
          ref={setRefs}
          className={cn(className)}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...rest}
        />
      </div>
    );
  },
);

VariableTextarea.displayName = "VariableTextarea";
