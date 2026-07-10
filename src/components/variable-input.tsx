"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { VariablePicker } from "@/components/variable-picker";
import { parseCustomFeatureToken } from "@/lib/custom-feature-token";
import { focusAfterInsert, insertAtCursor } from "@/lib/insert-at-cursor";
import { cn } from "@/lib/utils";

export type VariableInputProps = React.ComponentProps<typeof Input> & {
  currentNodeId: string;
  workflowId?: string;
  /** Insert a bare dotted path instead of the `@<path>@` template form. */
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
      // A custom-feature token owns the whole field (it must be its sole value),
      // so selecting one REPLACES the field instead of inserting at the cursor.
      // Otherwise re-configuring it (e.g. changing the padding) would append a
      // second token, and the anchored parser would then ignore both — leaving
      // the cell blank.
      if (parseCustomFeatureToken(variablePath)) {
        onChange?.({
          target: { value: variablePath, name: rest.name },
        } as React.ChangeEvent<HTMLInputElement>);
        return;
      }
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
        <div className="absolute bottom-1 right-1 z-10">
          <VariablePicker
            currentNodeId={currentNodeId}
            workflowId={workflowId}
            onSelect={handleVariableSelect}
            disabled={disabled}
            bare={bare}
            currentValue={strValue}
          />
        </div>
      </div>
    );
  },
);

VariableInput.displayName = "VariableInput";
