"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { useVariableField } from "@/components/use-variable-field";
import {
  HIGHLIGHTABLE_CONTROL_CLASS,
  HIGHLIGHTED_CONTROL_CLASS,
  VariableHighlight,
} from "@/components/variable-highlight";
import { VariablePicker } from "@/components/variable-picker";
import { parseCustomFeatureToken } from "@/lib/custom-feature-token";
import type { PickerExtraGroup } from "@/lib/upstream-fields";
import { cn } from "@/lib/utils";

export type VariableInputProps = React.ComponentProps<typeof Input> & {
  currentNodeId: string;
  workflowId?: string;
  /** Insert a bare dotted path instead of the `@<path>@` template form. */
  bare?: boolean;
  /** Fields the current node offers about itself (forwarded to VariablePicker). */
  extraGroups?: PickerExtraGroup[];
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
      onFocus,
      disabled,
      bare,
      extraGroups,
      ...rest
    },
    ref,
  ) => {
    const field = useVariableField<HTMLInputElement>({
      value,
      onChange,
      onFocus,
      name: rest.name,
      forwardedRef: ref,
      disabled,
    });

    const handleVariableSelect = (variablePath: string) => {
      // A custom-feature token owns the whole field (it must be its sole value),
      // so selecting one REPLACES the field instead of inserting at the cursor.
      // Otherwise re-configuring it (e.g. changing the padding) would append a
      // second token, and the anchored parser would then ignore both — leaving
      // the cell blank.
      if (parseCustomFeatureToken(variablePath)) {
        field.replaceAll(variablePath);
        return;
      }
      field.insert(variablePath);
    };

    // `bare` fields hold a raw dotted path, not `@<path>@` tokens, so there is
    // never anything for the highlight layer to pick out.
    const highlighted = field.highlighted && !bare;
    return (
      // `grid-cols-1` is Tailwind's `minmax(0, 1fr)`: the control and its
      // highlight layer share one cell that can't be widened by a long value.
      <div ref={field.containerRef} className="grid w-full grid-cols-1">
        <Input
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
            // The control's own className, or the two copies drift out of
            // glyph alignment.
            className={className}
          />
        ) : null}
        {/* Renders no inline DOM in field mode — only the panel, when open. */}
        <VariablePicker
          currentNodeId={currentNodeId}
          workflowId={workflowId}
          onSelect={handleVariableSelect}
          open={field.pickerOpen}
          onOpenChange={field.handlePickerOpenChange}
          disabled={disabled}
          bare={bare}
          currentValue={field.strValue}
          extraGroups={extraGroups}
          attachedTo={field.containerRef}
          query={field.query}
        />
      </div>
    );
  },
);

VariableInput.displayName = "VariableInput";
