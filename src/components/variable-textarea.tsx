"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { useVariableField } from "@/components/use-variable-field";
import {
  HIGHLIGHTABLE_CONTROL_CLASS,
  HIGHLIGHTED_CONTROL_CLASS,
  VariableHighlight,
} from "@/components/variable-highlight";
import { VariablePicker } from "@/components/variable-picker";
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
    const field = useVariableField<HTMLTextAreaElement>({
      value,
      onChange,
      name: rest.name,
      forwardedRef: ref,
      disabled,
    });

    const highlighted = field.highlighted;
    // Reserve space at the bottom so the picker button (bottom-right) never
    // sits over typed text. Shared by both copies so they stay glyph-aligned.
    const sharedClassName = cn("pb-10", className);

    return (
      // One cell shared by the control and its highlight layer — see
      // VariableInput for why the column is `minmax(0, 1fr)`.
      <div className="relative grid w-full grid-cols-1">
        <Textarea
          ref={field.setRefs}
          className={cn(
            "col-start-1 row-start-1",
            HIGHLIGHTABLE_CONTROL_CLASS,
            sharedClassName,
            highlighted && HIGHLIGHTED_CONTROL_CLASS,
          )}
          value={value}
          onChange={field.handleChange}
          disabled={disabled}
          {...rest}
        />
        {highlighted ? (
          <VariableHighlight
            value={field.strValue}
            controlRef={field.innerRef}
            multiline
            className={sharedClassName}
          />
        ) : null}
        <div className="absolute bottom-2 right-2 z-10">
          <VariablePicker
            currentNodeId={currentNodeId}
            workflowId={workflowId}
            onSelect={field.insert}
            open={field.pickerOpen}
            onOpenChange={field.handlePickerOpenChange}
            disabled={disabled}
          />
        </div>
      </div>
    );
  },
);

VariableTextarea.displayName = "VariableTextarea";
