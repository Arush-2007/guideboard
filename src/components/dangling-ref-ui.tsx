"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  type DanglingRef,
  groupByField,
  humanizeFieldKey,
} from "@/lib/dangling-refs";

/**
 * The two pieces both dangling-reference warnings are built from — the per-node
 * one in every settings dialog, and the whole-canvas one at save.
 *
 * They differ in what they group by (one node's fields vs. every offending node),
 * but a dead reference has to LOOK the same in both, and the destructive opt-in
 * has to behave the same. Kept here so the amber palette and the field-over-token
 * layout are stated once. The canvas badge builds the same content as plain
 * text from `groupByField`, since a tooltip cannot reuse markup.
 */

/**
 * How many of a field's dead values are spelled out before the rest become a
 * count. One bad wire into a wide sheet breaks a mapping per column; past a few
 * the list stops informing and starts burying the fields around it.
 */
const MAX_VALUES_SHOWN = 3;

/**
 * The dead references, one entry per FIELD — the thing the user has to go and
 * fix — with the values inside it beneath.
 *
 * Not one line per value: a single missing step takes every field that named
 * it, so a Sheets node routinely produces a dozen findings differing only in the
 * column name.
 */
export const DanglingRefRows = ({
  refs,
  className,
}: {
  refs: DanglingRef[];
  className?: string;
}) => (
  <ul className={className}>
    {groupByField(refs).map((group) => {
      const shown = group.refs.slice(0, MAX_VALUES_SHOWN);
      const hidden = group.refs.length - shown.length;
      return (
        <li key={group.field}>
          <span className="text-xs text-muted-foreground">
            {group.field ? humanizeFieldKey(group.field) : "This field"}
            {group.refs.length > 1 ? ` — ${group.refs.length} values` : null}
          </span>
          {shown.map((item) => (
            <span
              key={item.path}
              className="block break-all font-mono text-xs text-amber-700 dark:text-amber-400"
            >
              {`@<${item.path}>@`}
            </span>
          ))}
          {hidden > 0 ? (
            <span className="block text-xs text-muted-foreground">
              …and {hidden} more
            </span>
          ) : null}
        </li>
      );
    })}
  </ul>
);

/** The amber card one offending group sits in. */
export const DanglingRefCard = ({
  children,
}: {
  children: React.ReactNode;
}) => (
  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
    {children}
  </div>
);

/**
 * The opt-in that arms a destructive button. Deliberately a separate, deliberate
 * act: removing a reference is the only thing either warning does that loses
 * what the user typed.
 */
export const ConfirmDestructive = ({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) => (
  <div className="flex items-start gap-2.5 rounded-md border bg-muted/40 p-3">
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={(next) => onChange(next === true)}
      className="mt-0.5"
    />
    <Label htmlFor={id} className="text-sm font-normal leading-snug">
      {children}
    </Label>
  </div>
);
