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
      onFocus,
      disabled,
      ...rest
    },
    ref,
  ) => {
    const field = useVariableField<HTMLTextAreaElement>({
      value,
      onChange,
      onFocus,
      name: rest.name,
      forwardedRef: ref,
      disabled,
    });

    const highlighted = field.highlighted;

    return (
      // One cell shared by the control and its highlight layer — see
      // VariableInput for why the column is `minmax(0, 1fr)`.
      <div ref={field.containerRef} className="grid w-full grid-cols-1">
        <Textarea
          ref={field.setRefs}
          className={cn(
            "col-start-1 row-start-1",
            HIGHLIGHTABLE_CONTROL_CLASS,
            className,
            highlighted && HIGHLIGHTED_CONTROL_CLASS,
          )}
          value={value}
          onChange={field.handleChange}
          onFocus={field.handleFocus}
          onSelect={field.handleSelect}
          disabled={disabled}
          {...rest}
        />
        {highlighted ? (
          <VariableHighlight
            value={field.strValue}
            controlRef={field.innerRef}
            multiline
            // The control's own className, or the two copies drift out of
            // glyph alignment.
            className={className}
          />
        ) : null}
        {/* Renders no inline DOM in field mode — only the panel, when open. */}
        <VariablePicker
          currentNodeId={currentNodeId}
          workflowId={workflowId}
          onSelect={field.insert}
          open={field.pickerOpen}
          onOpenChange={field.handlePickerOpenChange}
          disabled={disabled}
          attachedTo={field.containerRef}
          query={field.query}
        />
      </div>
    );
  },
);

VariableTextarea.displayName = "VariableTextarea";
