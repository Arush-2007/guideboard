"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { VariablePicker } from "@/components/variable-picker";
import { focusAfterInsert, insertAtCursor } from "@/lib/insert-at-cursor";
import { cn } from "@/lib/utils";

export type VariableInputProps = React.ComponentProps<typeof Input> & {
  currentNodeId: string;
  workflowId?: string;
  /** Insert a bare dotted path instead of the `!#path#!` template form. */
  bare?: boolean;
};

export const VariableInput = React.forwardRef<
  HTMLInputElement,
  VariableInputProps
>(
  (
    {
      className,
      currentNodeId,
      workflowId,
      value,
      onChange,
      disabled,
      bare,
      ...rest
    },
    ref,
  ) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);

    const setRefs = (node: HTMLInputElement | null) => {
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
      } as React.ChangeEvent<HTMLInputElement>;
      onChange?.(synthetic);
      if (el && el.selectionStart != null) {
        focusAfterInsert(el, start + variablePath.length);
      }
    };

    return (
      <div className="relative w-full">
        <Input
          ref={setRefs}
          className={cn("pr-10", className)}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...rest}
        />
        <div className="absolute right-1 top-1/2 z-10 -translate-y-1/2">
          <VariablePicker
            currentNodeId={currentNodeId}
            workflowId={workflowId}
            onSelect={handleVariableSelect}
            disabled={disabled}
            bare={bare}
          />
        </div>
      </div>
    );
  },
);

VariableInput.displayName = "VariableInput";
