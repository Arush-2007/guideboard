"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomFeature } from "@/config/custom-features";
import {
  encodeCustomFeatureToken,
  parseCustomFeatureToken,
} from "@/lib/custom-feature-token";

/**
 * A single node "custom feature" in the variable picker. Expands on click to
 * configure its inline params, previews the result, and inserts the encoded
 * token into the field. Only the node that declares the feature (and whose
 * executor interprets the token) offers it.
 */
export function CustomFeatureEntry({
  feature,
  currentValue,
  onInsert,
}: {
  feature: CustomFeature;
  /** The field's current value — used to pre-fill from an already-saved token. */
  currentValue?: string;
  onInsert: (token: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Seed the inputs from the previously-saved token (if the field already holds
  // this feature), falling back to each param's default. Re-reads on every mount
  // (the picker popover remounts on open), so re-opening shows the last values.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const saved = parseCustomFeatureToken(currentValue);
    const savedParams = saved?.featureId === feature.id ? saved.params : {};
    return Object.fromEntries(
      feature.params.map((p) => [
        p.key,
        savedParams[p.key] ?? String(p.default),
      ]),
    );
  });

  // Coerce the (string) inputs to numbers, falling back to each param default.
  const resolved = Object.fromEntries(
    feature.params.map((p) => {
      const n = Number.parseInt(values[p.key] ?? "", 10);
      return [p.key, Number.isFinite(n) ? n : p.default];
    }),
  ) as Record<string, number>;

  const preview = previewFor(feature.id, resolved);

  return (
    <li>
      <button
        type="button"
        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="font-medium text-foreground">{feature.label}</span>
        {feature.description ? (
          <span className="w-full break-words text-xs text-muted-foreground">
            {feature.description}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-2 px-2 pb-2">
          {feature.params.map((p) => (
            <div
              key={p.key}
              className="flex items-center justify-between gap-2"
            >
              <Label className="text-xs text-muted-foreground">{p.label}</Label>
              <Input
                type="number"
                min={p.min}
                value={values[p.key] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [p.key]: e.target.value }))
                }
                className="h-8 w-24"
              />
            </div>
          ))}
          {preview ? (
            <p className="text-xs text-muted-foreground">
              Preview: <span className="font-mono">{preview}</span>
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={() =>
              onInsert(encodeCustomFeatureToken(feature.id, resolved))
            }
          >
            Insert {feature.label}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Per-feature preview of the first few produced values (extend per feature). */
function previewFor(
  featureId: string,
  params: Record<string, number>,
): string | null {
  if (featureId !== "serialNumber") return null;
  const start = params.start ?? 1;
  const pad = params.pad ?? 0;
  const fmt = (n: number) =>
    pad > 0 ? String(n).padStart(pad, "0") : String(n);
  return `${fmt(start)}, ${fmt(start + 1)}, ${fmt(start + 2)}, …`;
}
